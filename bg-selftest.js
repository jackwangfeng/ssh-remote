// 拿真实长任务验证后台任务工具：全量测试约 6 分钟，
// 重点验三件事——起任务立刻返回、running 状态拿得到、中途状态会变。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 非 JSON 行忽略 */ }
  }
});
let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args) {
  const t = Date.now();
  const r = await request('tools/call', { name, arguments: args ?? {} });
  const ms = Date.now() - t;
  const p = r.result ?? r.error;
  const body = p?.content?.[0]?.text ?? JSON.stringify(p);
  return { ms, body, isError: Boolean(p?.isError) };
}

const init = await request('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'bgtest', version: '1.0.0' },
});
console.log('initialize', init.error ? 'FAIL' : 'ok');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// 起真实的全量测试
const t0 = Date.now();
const bg = await call('remote_exec_bg', {
  command: 'export PATH=/usr/local/go/bin:$PATH; PGPORT=55432 make test-db TEST_TIMEOUT=10m 2>&1; echo "EXITCODE=$?"',
  name: 'full-test',
});
const jobId = JSON.parse(bg.body).jobId;
console.log(`起任务耗时 ${Date.now() - t0}ms（含建连），jobId=${jobId}`);

if (Date.now() - t0 > 2000) {
  console.log('✗ 起任务超过 2 秒 —— 那就没达到「不阻塞」的目的');
} else {
  console.log('✓ 起任务立即返回，没有等 6 分钟');
}

// 立刻查一次，确认拿得到 running
const first = await call('remote_job_check', { jobId, tail: 3 });
const fd = JSON.parse(first.body);
console.log(`立即查: status=${fd.status} elapsed=${fd.elapsedSec}s`);

// 隔一会儿再查，确认状态在推进
for (const waitMs of [30000, 60000]) {
  await new Promise((r) => setTimeout(r, waitMs));
  const c = await call('remote_job_check', { jobId, tail: 3 });
  const d = JSON.parse(c.body);
  const lastLine = String(d.log ?? '').split('\n').slice(-1)[0];
  console.log(`  ${Math.round(d.elapsedSec)}s  ${d.status}  ${lastLine.slice(0, 60)}`);
}

// 轮询到终态
let final;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const c = await call('remote_job_check', { jobId, tail: 5 });
  final = JSON.parse(c.body);
  if (final.status !== 'running') break;
}

const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(`\n终态: ${final.status}  exitCode=${final.exitCode}  实测耗时 ${elapsed}s`);
const okCount = (String(final.log ?? '').match(/^ok\s/gm) ?? []).length;
const failCount = (String(final.log ?? '').match(/^FAIL/gm) ?? []).length;
console.log(`日志里 ok=${okCount} FAIL=${failCount}`);

// 终态下再查一次，确认幂等（不会因为已结束就报错）
const again = await call('remote_job_check', { jobId, tail: 1 });
console.log(`终态再查: ${again.isError ? '报错✗' : JSON.parse(again.body).status}`);

const list = await call('remote_job_list', { all: true });
console.log(`\nlist:\n${list.body}`);

child.kill();
