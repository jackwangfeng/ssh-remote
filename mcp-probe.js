/**
 * MCP 端到端探针：启动 server.js 子进程，走真实 JSON-RPC 握手，
 * 列出工具并实际调用几个，顺带记录耗时。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

class Probe {
  constructor() {
    this.child = spawn(NODE, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.id = 0;
    this.pending = new Map();
    this.buffer = '';
    this.child.stdout.on('data', (d) => {
      this.buffer += d.toString('utf8');
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    this.child.stderr.on('data', (d) => {
      process.stderr.write(`  [server] ${d.toString('utf8').trimEnd()}\n`);
    });
  }

  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`超时: ${method}`)), 60000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close() {
    try { this.child.kill(); } catch { /* 忽略 */ }
  }
}

async function callTool(probe, name, args) {
  const start = Date.now();
  const res = await probe.request('tools/call', { name, arguments: args ?? {} });
  const ms = Date.now() - start;
  const payload = res.result ?? res.error;
  const body = payload?.content?.[0]?.text ?? JSON.stringify(payload);
  console.log(`  ${name.padEnd(16)} ${String(ms).padStart(6)}ms  ${body.split('\n').slice(0, 4).join(' ⏎ ')}`);
  if (payload?.isError) console.log(`      ↑ 调用报错`);
  return { ms, body, isError: Boolean(payload?.isError) };
}

async function main() {
  const probe = new Probe();
  let failed = false;

  try {
    console.log('MCP 端到端探针');
    console.log('─'.repeat(70));

    const init = await probe.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1.0.0' },
    });
    if (init.error) throw new Error(`initialize 失败: ${JSON.stringify(init.error)}`);
    console.log(`  initialize ✓  server=${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
    probe.notify('notifications/initialized');

    const list = await probe.request('tools/list', {});
    const tools = list.result.tools.map((t) => t.name);
    console.log(`  tools/list  ✓  ${tools.length} 个工具: ${tools.join(', ')}\n`);

    console.log('  实际调用:');
    await callTool(probe, 'remote_health', {});
    // 第二次 health 用来检验连接确实被复用
    await callTool(probe, 'remote_health', {});
    await callTool(probe, 'remote_exec', { command: 'pwd && git log --oneline -1' });
    // 走 ripgrep：确认远端装了 rg 后确实被选中、且没因为没有路径参数而读 stdin 挂住
    await callTool(probe, 'remote_search', { pattern: 'ChannelAlloc', maxResults: 3 });
    await callTool(probe, 'remote_search', { pattern: 'func NewPool', type: 'go', context: 1, maxResults: 6 });
    await callTool(probe, 'remote_find', { pattern: 'dsn\\.go$', maxResults: 5 });
    await callTool(probe, 'remote_search', { pattern: 'zzz_no_such_symbol', maxResults: 3 });
    await callTool(probe, 'remote_list', { path: 'internal', maxEntries: 6 });
    const read = await callTool(probe, 'remote_read', { path: 'go.mod', endLine: 5 });
    if (read.isError) failed = true;
    if (!read.body.includes('module')) { console.log('  ✗ remote_read 没读到内容'); failed = true; }

    await callTool(probe, 'remote_stat', { path: 'Makefile' });

    // ── 后台任务 ──────────────────────────────────────────────────────
    // 要验三件事，而不只是「工具在列表里」：
    //   1. 起任务立刻返回（不阻塞）——这是它存在的全部理由
    //   2. running → done 的状态迁移，且退出码要准
    //   3. 分号不能把命令切坏（用一条自带分号的命令来试）
    console.log('\n  后台任务:');
    const bg = await callTool(probe, 'remote_exec_bg', {
      command: 'sleep 3; echo "分号没被切开"; exit 7',
      name: 'probe-selftest',
    });
    let jobId = null;
    try { jobId = JSON.parse(bg.body).jobId; } catch { /* 已在上面打印 */ }
    if (!jobId) {
      console.log('  ✗ remote_exec_bg 没给出 jobId');
      failed = true;
    } else {
      // 刚起时应该在跑
      await new Promise((r) => setTimeout(r, 600));
      const mid = await callTool(probe, 'remote_job_check', { jobId, tail: 5 });
      let midD = {};
      try { midD = JSON.parse(mid.body); } catch { /* 下面会因字段缺失而失败 */ }
      if (midD.status !== 'running') {
        console.log(`  ✗ 起 shortly 之后应为 running，实际 ${midD.status}`); failed = true;
      }
      // 等它跑完，验终态与退出码
      await new Promise((r) => setTimeout(r, 4000));
      const done = await callTool(probe, 'remote_job_check', { jobId, tail: 5 });
      let doneD = {};
      try { doneD = JSON.parse(done.body); } catch { /* 同上 */ }
      // 断言走解析后的字段而不是子串匹配：text() 是 JSON.stringify，
      // 冒号后带空格，写 '"status":"failed" 这种子串会永远匹配不上。
      if (doneD.status !== 'failed') {
        console.log(`  ✗ exit 7 应判为 failed，实际 ${doneD.status}`); failed = true;
      }
      if (doneD.exitCode !== 7) {
        console.log(`  ✗ 退出码应为 7，实际 ${doneD.exitCode}`); failed = true;
      }
      if (!String(doneD.log ?? '').includes('分号没被切开')) {
        console.log(`  ✗ 日志里没有命令输出 —— 分号可能把命令切坏了：${doneD.log}`); failed = true;
      }
      await callTool(probe, 'remote_job_list', { all: true });
      // 查一个不存在的任务：必须报错而不是静默返回空
      const nope = await callTool(probe, 'remote_job_check', { jobId: 'nope-does-not-exist' });
      if (!nope.isError) { console.log('  ✗ 不存在的 jobId 应报错'); failed = true; }
      // jobId 注入防护：路径穿越必须被挡
      const inj = await callTool(probe, 'remote_job_check', { jobId: '../../etc' });
      if (!inj.isError) { console.log('  ✗ 路径穿越的 jobId 应被拒绝'); failed = true; }
    }

    console.log('\n' + '─'.repeat(70));
    console.log(failed ? '✗ 有用例失败' : '✓ 全部通过');
  } catch (e) {
    console.error(`\n✗ 探针异常: ${e.message}`);
    process.exitCode = 1;
  } finally {
    probe.close();
  }
}

main();
