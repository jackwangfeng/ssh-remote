/**
 * 独立冒烟测试：验证 SSH 长连接是否真的省掉了握手开销。
 * 不依赖 MCP，直接用 node smoke-test.js 跑。
 *
 * 看两个数：
 *   1) 首次建连是一次性成本
 *   2) 后续调用是否压到毫秒级（同一条 TCP 连接复用）
 */

import os from 'node:os';
import path from 'node:path';
import { RemoteSession } from './ssh-session.js';

// 冒烟测试的目标机也从环境变量读，跟 server.js 保持同一套配置。
for (const n of ['SSH_REMOTE_HOST', 'SSH_REMOTE_USER']) {
  if (!process.env[n]) {
    console.error(`smoke-test 需要环境变量 ${n}，例如：`);
    console.error('  SSH_REMOTE_HOST=192.168.0.110 SSH_REMOTE_USER=yourname SSH_REMOTE_BASE=/home/yourname/work/yourproject node smoke-test.js');
    process.exit(1);
  }
}
const HOST = process.env.SSH_REMOTE_HOST;
const USER = process.env.SSH_REMOTE_USER;
const KEY = process.env.SSH_REMOTE_KEY ?? path.join(os.homedir(), '.ssh', 'id_ed25519');
const REMOTE_HOME = process.env.SSH_REMOTE_HOME ?? `/home/${USER}`;
const PROJECT = process.env.SSH_REMOTE_BASE ?? `${REMOTE_HOME}`;

const session = new RemoteSession({
  host: HOST,
  username: USER,
  keyPath: KEY,
});

async function timed(label, fn) {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  console.log(`  ${label.padEnd(42)} ${String(ms).padStart(6)} ms`);
  return { result, ms };
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exitCode = 1;
}

async function main() {
  console.log('SSH 长连接冒烟测试');
  console.log('─'.repeat(64));

  let ok = true;

  try {
    const { result: conn } = await timed('首次建立连接（一次性成本）', () => session.ensure());
    if (!conn) { fail('没有拿到连接'); return; }

    console.log('\n  命令执行（应复用同一条连接）:');
    const runs = [];
    let baseline = null; // 首次的 hostname 输出，作为后续比对的基准（不硬编码任何主机名）
    for (let i = 1; i <= 5; i++) {
      const { result, ms } = await timed(`第 ${i} 次 exec hostname`, () => session.exec('hostname'));
      runs.push(ms);
      const out = result.stdout.trim();
      if (i === 1) {
        baseline = out;
        console.log(`      远端主机名: ${out}`);
      } else if (out !== baseline) {
        fail(`第 ${i} 次输出与首次不一致: ${JSON.stringify(out)} vs ${JSON.stringify(baseline)}`);
        ok = false;
      }
    }
    const after = runs.slice(1);
    const avg = Math.round(after.reduce((a, b) => a + b, 0) / after.length);
    console.log(`\n  第 2 次起平均: ${avg} ms`);
    if (avg > 200) {
      fail(`后续调用没有降下来（${avg}ms），长连接可能没生效`);
      ok = false;
    }

    console.log('\n  文件操作:');
    // 从 baseDir 列目录里挑一个真实文件来读，不假设项目结构（语言、目录名都不写死）
    const { result: probe } = await timed('SFTP 列 baseDir', () => session.readdir(PROJECT));
    const files = (probe.entries ?? []).filter((e) => e.type === 'file' && !e.name.startsWith('.'));
    if (files.length) {
      const { result: rd } = await timed(`SFTP 读 ${files[0].name}`, () =>
        session.readFile(`${PROJECT}/${files[0].name}`, { maxBytes: 8192 }));
      console.log(`      读到 ${rd.bytes} 字节`);
    } else {
      console.log('      baseDir 下没有可读文件，跳过');
    }

    console.log('\n  批处理（一次调用跑多条命令）:');
    const { result: batch, ms: batchMs } = await timed('一条命令取 host/user/pwd/git状态', () =>
      session.exec(
        `echo "host=$(hostname)"; echo "user=$(whoami)"; echo "pwd=$(pwd)"; ` +
        `if [ -d .git ]; then echo "branch=$(git branch --show-current)"; echo "dirty=$(git status --short | wc -l)"; fi`,
        { cwd: PROJECT, timeout: 30000 },
      ));
    console.log(`      ${batch.stdout.trim().split('\n').join(' | ')}`);

    console.log('\n  连接状态检查:');
    const { result: check } = await timed('确认仍是同一条连接', async () => {
      const before = session.conn;
      await session.ensure();
      return { same: before === session.conn };
    });
    if (!check.same) { fail('ensure() 没有复用连接，说明重连了'); ok = false; }

    console.log('\n' + '─'.repeat(64));
    if (ok) {
      console.log('✓ 全部通过。对比参考：走 ssh 命令行单次约 900ms，批处理 5 条约 830ms');
      console.log(`  这里第 2 次起的单次命令 ≈ ${avg}ms`);
    }
  } catch (e) {
    console.error(`\n✗ 测试中断: ${e.message}`);
    console.error(e.stack?.split('\n').slice(1, 4).join('\n') ?? '');
    process.exitCode = 1;
  } finally {
    session.close();
  }
}

main();
