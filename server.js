#!/usr/bin/env node
/**
 * ssh-remote —— 常驻 SSH 长连接的 MCP server（通用，与具体项目无关）。
 *
 * 为什么造它：本机每次 ssh 命令行调用约 900ms，其中进程创建 ~480ms、握手 ~420ms，
 * 网络往返其实不到 1ms。Windows 又不支持 SSH multiplexing。
 * 于是改成：一个常驻进程 hold 住 SSH 连接，通过 MCP 暴露工具，
 * 调用时不创建新进程、不重新握手 —— 单次命令压到几十毫秒。
 *
 * 目标机器完全由环境变量决定，换机器/多机器并行都只需改配置：
 *   SSH_REMOTE_HOST / SSH_REMOTE_PORT / SSH_REMOTE_USER
 *   SSH_REMOTE_KEY  / SSH_REMOTE_BASE / SSH_REMOTE_HOME
 * 同一台机器只需注册一个 server；不同机器才注册多个条目（名字区分，如 ssh-remote-2）。
 *
 * 安全边界：目标主机由这里的 CONFIG 固定，工具参数无法指定别的主机。
 * stdout 专供 MCP 协议使用，任何日志都必须走 stderr。
 */

import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RemoteSession, shellQuote } from './ssh-session.js';

/**
 * 目标机配置全部走环境变量，必填项缺失就在启动时直接报错并告诉用户怎么配——
 * 免得拿着空主机名去连，报一堆看不懂的 ssh 错误。
 */
function requiredEnv(name, hint) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `[ssh-remote] 缺少必需的环境变量 ${name}${hint ? `（${hint}）` : ''}。\n` +
      `  在 MCP 客户端配置里给 ssh-remote 加env 段，例如：\n` +
      `  "env": { "${name}": "实际值" }\n` +
      `  完整变量：SSH_REMOTE_HOST / SSH_REMOTE_PORT / SSH_REMOTE_USER / SSH_REMOTE_KEY / SSH_REMOTE_BASE / SSH_REMOTE_HOME`,
    );
    process.exit(1);
  }
  return v;
}

const CONFIG = {
  host: requiredEnv('SSH_REMOTE_HOST', '目标机地址或主机名'),
  port: Number(process.env.SSH_REMOTE_PORT ?? 22),
  username: requiredEnv('SSH_REMOTE_USER', '登录用户名'),
  keyPath: process.env.SSH_REMOTE_KEY ?? path.join(os.homedir(), '.ssh', 'id_ed25519'),
  // 相对路径的解析基准。必须是**绝对路径**：baseDir 会被拼进远端 `cd "..."`，
  // 双引号里~ 不做展开，写成 ~/work/xxx 会直接 cd 失败。
  baseDir: requiredEnv('SSH_REMOTE_BASE', '远端工作目录的绝对路径'),
  // ~ 展开的基准。默认从 username 推导，避免用户名不同却仍写死旧 home
  homeDir: process.env.SSH_REMOTE_HOME ?? `/home/${process.env.SSH_REMOTE_USER ?? ''}`,
};

// 后台任务的状态目录。放 /tmp 而不是项目里：任务日志不该进 git，也不该被
// 任何目录遍历工具扫到。/tmp 在 Linux 上重启即失，恰好符合「日志是临时的」这层意思。
const JOBS_DIR = '/tmp/ssh-remote-jobs';

const session = new RemoteSession({
  host: CONFIG.host,
  port: CONFIG.port,
  username: CONFIG.username,
  keyPath: CONFIG.keyPath,
});

/** 相对路径基于 baseDir；~ 开头基于 homeDir；绝对路径原样返回 */
function resolvePath(p) {
  if (!p) return CONFIG.baseDir;
  if (p.startsWith('~')) return path.posix.join(CONFIG.homeDir, p.slice(1));
  if (p.startsWith('/')) return p;
  return path.posix.join(CONFIG.baseDir, p);
}

function text(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

function failRes(err) {
  const msg = err?.message ?? String(err);
  return { content: [{ type: 'text', text: `错误: ${msg}` }], isError: true };
}

const TOOLS = [
  {
    name: 'remote_exec',
    description:
      '在远端服务器执行命令。默认工作目录是 SSH_REMOTE_BASE 指定的目录。把多条命令用 && 串成一次调用更省时间——成本在调用次数，不在命令条数。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录，默认 SSH_REMOTE_BASE 指定的目录；可用绝对路径或相对路径' },
        timeout: { type: 'number', description: '超时毫秒数，默认 120000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'remote_read',
    description: '读取远端文件。支持按行区间读取，返回带行号以便后续精确修改。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对路径基于 SSH_REMOTE_BASE，也支持 ~ 和绝对路径' },
        startLine: { type: 'number', description: '起始行号（1 起），不填则从头' },
        endLine: { type: 'number', description: '结束行号（含），不填则到尾' },
        maxBytes: { type: 'number', description: '最大读取字节数，默认 512KB' },
      },
      required: ['path'],
    },
  },
  {
    name: 'remote_write',
    description: '整文件写入远端。改大文件前建议先 remote_read 确认内容。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'remote_replace',
    description:
      '在远端文件里做精确字符串替换，无需传整个文件。old_string 必须唯一匹配，否则报错——这是为了防止改错地方。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        oldString: { type: 'string', description: '要被替换的原始片段，需精确匹配（含缩进）' },
        newString: { type: 'string', description: '替换后的内容' },
        replaceAll: { type: 'boolean', description: '是否替换全部匹配，默认 false（要求唯一匹配）' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'remote_list',
    description: '列出远端目录内容，返回类型、大小、修改时间。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认 SSH_REMOTE_BASE 指定的目录' },
        maxEntries: { type: 'number', description: '最多返回条目数，默认 300' },
      },
    },
  },
  {
    name: 'remote_search',
    description: '在远端按内容搜索（优先 ripgrep，远端没装时回退 grep）。适合跨文件找符号、找引用。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的文本或正则' },
        path: { type: 'string', description: '搜索起点，默认 SSH_REMOTE_BASE 指定的目录' },
        include: { type: 'string', description: '文件名过滤，如 "*.go"；不填则不限' },
        type: { type: 'string', description: '按文件类型过滤：go / sql / md / yaml 等；与 include 二选一' },
        context: { type: 'number', description: '每个匹配上下各带几行上下文，默认 0' },
        maxResults: { type: 'number', description: '最多返回行数，默认 100' },
        caseSensitive: { type: 'boolean', description: '大小写敏感，默认 true' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'remote_find',
    description: '在远端按文件名查找（走 fd-find，缺失时回退 find）。比 remote_list 递归快得多。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名片段或正则，如 "order" 或 "\\\\.go$"' },
        path: { type: 'string', description: '查找起点，默认 SSH_REMOTE_BASE 指定的目录' },
        type: { type: 'string', description: 'd=只要目录，f=只要文件；不填则不限' },
        maxResults: { type: 'number', description: '最多返回条数，默认 100' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'remote_stat',
    description: '查看远端文件或目录是否存在及其属性（类型、大小、修改时间、权限）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '路径' } },
      required: ['path'],
    },
  },
  {
    name: 'remote_health',
    description: '查看 SSH 长连接状态；断线时会自动重连一次。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remote_exec_bg',
    description: '后台起一个远端任务，立即返回不等待。适合编译、全量测试、构建镜像这类几分钟的活——'
      + '返回 jobId，之后用 remote_job_check 查结果。任务状态存在远端文件系统上，'
      + '本工具重启、甚至 WorkBuddy 重启后照样能接着查。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要跑的完整命令，会过 shell' },
        cwd: { type: 'string', description: '工作目录，默认 SSH_REMOTE_BASE 指定的目录' },
        name: { type: 'string', description: '任务标签，便于事后辨认，如 full-test' },
      },
      required: ['command'],
    },
  },
  {
    name: 'remote_job_check',
    description: '查一个后台任务的状态与输出。返回 running / done / failed，'
      + '终态时带退出码和日志末尾若干行。',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'remote_exec_bg 返回的 id' },
        tail: { type: 'number', description: '返回日志末尾多少行，默认 40' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'remote_job_list',
    description: '列出当前所有后台任务，含在跑的和已结束的（按开始时间倒序）。',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'true  连已结束的一起列；默认只列还在跑的' },
      },
    },
  },
];

const handlers = {
  async remote_exec({ command, cwd, timeout }) {
    const r = await session.exec(command, {
      cwd: cwd ? resolvePath(cwd) : CONFIG.baseDir,
      timeout: timeout ?? 120000,
    });
    const parts = [];
    if (r.stdout) parts.push(r.stdout);
    if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
    if (r.code !== 0) parts.push(`[退出码 ${r.code}${r.signal ? `/${r.signal}` : ''}]`);
    if (r.timedOut) parts.push(`[执行超时]`);
    if (r.truncated) parts.push(`[输出被截断]`);
    return text(parts.join('\n').trimEnd() || '(无输出)');
  },

  async remote_read({ path: p, startLine, endLine, maxBytes }) {
    const remotePath = resolvePath(p);
    const r = await session.readFile(remotePath, { maxBytes: maxBytes ?? 512 * 1024 });
    const lines = r.content.split('\n');
    const s = Math.max(1, Number(startLine) || 1);
    const e = Math.min(lines.length, Number(endLine) || lines.length);
    const slice = lines.slice(s - 1, e);
    const numbered = slice.map((l, i) => `${s + i}\t${l}`).join('\n');
    const head = `[${remotePath}] 共 ${lines.length} 行，${r.bytes} 字节${r.truncated ? '（已截断）' : ''}`;
    return text(`${head}\n${numbered}`);
  },

  async remote_write({ path: p, content }) {
    const remotePath = resolvePath(p);
    const r = await session.writeFile(remotePath, content);
    return text(`已写入 ${remotePath}（${r.bytes} 字节）`);
  },

  async remote_replace({ path: p, oldString, newString, replaceAll }) {
    const remotePath = resolvePath(p);
    const cur = await session.readFile(remotePath, { maxBytes: 8 * 1024 * 1024 });
    if (cur.truncated) {
      throw new Error('文件过大，未能完整读取，拒绝替换以避免损坏内容');
    }
    const content = cur.content;
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      throw new Error(`oldString 未在 ${remotePath} 中找到，请确认内容完全一致（含缩进与换行）`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(`oldString 匹配到 ${count} 处，存在歧义。请补充更多上下文使其唯一，或显式传 replaceAll: true`);
    }
    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    await session.writeFile(remotePath, next);
    const delta = next.length - content.length;
    return text(`已替换 ${remotePath}${replaceAll ? `（${count} 处）` : ''}，字符数变化 ${delta > 0 ? '+' : ''}${delta}`);
  },

  async remote_list({ path: p, maxEntries }) {
    const r = await session.readdir(resolvePath(p ?? ''), { maxEntries: maxEntries ?? 300 });
    const body = r.entries
      .map((e) => {
        const size = e.type === 'dir' ? '-' : String(e.size);
        return `${e.type.padEnd(4)} ${size.padStart(9)}  ${e.mtime ?? ''}  ${e.name}`;
      })
      .join('\n');
    const tail = r.truncated ? `\n… 共 ${r.total} 项，已截断至 ${maxEntries ?? 300}` : '';
    return text(`[${r.path}]\n${body}${tail}`);
  },

  async remote_search({ pattern, path: p, include, type, context, maxResults, caseSensitive }) {
    const base = resolvePath(p ?? '');
    const max = maxResults ?? 100;
    const pat = shellQuote(pattern);
    const root = shellQuote(base);
    const limit = `| head -n ${max}`;

    // 优先 ripgrep：并行递归、自动跳过 .gitignore 与二进制文件，几百个文件的仓库里
    // 比 grep 快一个量级。远端没装时回退 grep，工具缺失不该让整个能力消失。
    //
    // 用 if/expr 而不是 `rg ... || grep ...`：没匹配时 rg 退出码是 1，接 || 会误判成
    // 「rg 不存在」而再跑一遍 grep，白白加倍耗时还可能出现第二份输出。
    const rg = [
      'rg', '-n', '--no-heading', '--color=never', '--no-messages',
      caseSensitive ? '' : '-i',
      type ? `-t ${shellQuote(type)}` : '',
      include ? `-g ${shellQuote(include)}` : '',
      context ? `-C ${Number(context)}` : '',
      pat, root,
    ].filter(Boolean).join(' ');

    const gr = [
      'grep', '-rn', '--binary-files=without-match', '--no-messages',
      caseSensitive ? '' : '-i',
      include ? `--include=${shellQuote(include)}` : '',
      pat, root,
    ].filter(Boolean).join(' ');

    // < /dev/null 是防御性的，但必要：rg 在没有路径参数时会去读 stdin，而在 ssh exec 里
    // stdin 是一个不会自己关闭的流——于是 rg 安静地挂在那里，直到超时，一个字都不输出。
    // 显式给搜索根目录已经是第一道防线，这道是第二道。
    const cmd =
      `if command -v rg >/dev/null 2>&1; then ${rg} ${limit}; else ${gr} ${limit}; fi < /dev/null`;
    const r = await session.exec(cmd, { timeout: 60000 });
    return text(r.stdout.trimEnd() || `没有匹配：${pattern}（在 ${base}）`);
  },

  async remote_find({ pattern, path: p, type, maxResults }) {
    const base = resolvePath(p ?? '');
    const max = maxResults ?? 100;
    const pat = shellQuote(pattern);
    const root = shellQuote(base);
    const limit = `| head -n ${max}`;

    const fd = [
      'fdfind', '--color=never', '--hidden', '--no-ignore-vcs',
      type === 'd' ? '--type d' : type === 'f' ? '--type f' : '',
      pat, root,
    ].filter(Boolean).join(' ');

    const fi = [
      'find', root,
      type === 'd' ? '-type d' : type === 'f' ? '-type f' : '',
      '-regex', `.*${pattern}.*`,
    ].filter(Boolean).join(' ');

    // < /dev/null 见 remote_search：非 TTY 下没有它，读 stdin 的工具会挂住。
    const cmd =
      `if command -v fdfind >/dev/null 2>&1; then ${fd} ${limit}; else ${fi} ${limit}; fi < /dev/null`;
    const r = await session.exec(cmd, { timeout: 60000 });
    return text(r.stdout.trimEnd() || `没有匹配的文件名：${pattern}（在 ${base}）`);
  },

  async remote_stat({ path: p }) {
    const remotePath = resolvePath(p);
    try {
      return text(await session.stat(remotePath));
    } catch (e) {
      if (/no such file|not exist/i.test(e.message)) {
        return text({ path: remotePath, exists: false });
      }
      throw e;
    }
  },

  async remote_health() {
    const wasConnected = session.isConnected;
    const start = Date.now();
    try {
      await session.ensure();
      const r = await session.exec('hostname && uptime | sed "s/^ *//"');
      return text({
        connected: true,
        reusedExistingConnection: wasConnected,
        connectOrEnsureMs: Date.now() - start,
        target: `${CONFIG.username}@${CONFIG.host}:${CONFIG.port}`,
        keyPath: CONFIG.keyPath,
        baseDir: CONFIG.baseDir,
        server: r.stdout.trim().replace(/\n/g, ' | '),
      });
    } catch (e) {
      await session.reconnect().catch(() => {});
      return failRes(new Error(`${e.message}（已尝试重连）`));
    }
  },

  // ── 后台任务 ────────────────────────────────────────────────────────
  // 为什么要自己造而不等官方的 Tasks 扩展（io.modelcontextprotocol/tasks）：
  // 那套已经不在核心规范里了（SEP-2663），且要求客户端在每个请求的 _meta 里显式
  // opt-in，没声明就必须退回阻塞——而客户端支不支持无法确认。规范里说服务端可以推
  // notifications/tasks/status，但同一句又写着 MUST NOT rely on receiving，所以
  // 轮询本来就是那条路的默认。用普通工具实现，兼容性拉满，改动只有几十行。
  //
  // 状态刻意全放远端文件系统（/tmp/ssh-remote-jobs/<jobId>/）：进程内存会随 WorkBuddy
  // 重启消失，而「测试跑了两小时，中途重启了，现在什么状态」是真实会发生的情况。
  async remote_exec_bg({ command, cwd, name }) {
    if (!command || !String(command).trim()) throw new Error('command 不能为空');

    // jobId 用时间戳 + 随机后缀：可排序（列表里天然按时间倒序），且不会撞。
    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const dir = `${JOBS_DIR}/${jobId}`;

    // 元数据用 `command \0 cwd \0 name` 三段 null 分隔写单文件，而不是三个文件：
    // 少两次 ssh 往返，也避免「写了一半」的中间态。
    //
    // 拼脚本时每行用换行分隔而非 '; ' —— command 是用户给的，里面自带分号是常事，
    // 用分号拼行会把一条命令切成两条，症状是「任务跑了个寂寞」。

    // runner 脚本单独写成一个文件再执行，而不是 `bash -c '...'` 内联。
    // 内联的话，用户命令里的引号会和外层 bash -c 的引号打架——实测
    // `exit 7` 会被外层拆成 `exit` 加一个非数字参数，任务直接死在校验那一步，
    // 而外层看到的只是「起成功了」。写成文件（内容用 base64 传输）就没有嵌套层级。
    //
    // 用户命令必须跑在**子 shell** 里，而且要用 `bash -c`：
    //   - 直接展开在脚本里，命令里的 `exit 7` 会把整个 runner 脚本一起带走，
    //     后面那行写 exit 文件的代码根本执行不到 —— 症状是任务明明跑完了，
    //     状态却是 vanished（进程没了、退出码文件也没有）。
    //   - 用 `bash -c` 而不是 `sh -c`：用户命令多半是 bash 语法（管道、&&、数组），
    //     dash 不认那些。
    //   - 最后再 `|| true`：命令非零退出时子 shell 返回非零，而我们要的是它的退出码，
    //     不是 runner 自己失败。
    const runnerB64 = Buffer.from(
      [
        '#!/usr/bin/env bash',
        'set +e',
        `cd ${JSON.stringify(cwd ? resolvePath(cwd) : CONFIG.baseDir)} || exit 70`,
        `bash -c ${JSON.stringify(String(command))}`,
        'code=$?',
        `printf '%s' "$code" > ${JSON.stringify(`${dir}/exit`)}`,
        'exit 0',
      ].join('\n'),
      'utf8',
    ).toString('base64');

    const bootstrap = [
      'set -u',
      `mkdir -p ${shellQuote(dir)} || exit 70`,
      `printf '%s\\0%s\\0%s\\0%s' "$(date +%s)" ${shellQuote(command)} ${shellQuote(cwd ?? CONFIG.baseDir)} ${shellQuote(name ?? '')} > ${shellQuote(`${dir}/meta`)}`,
      // base64 是为了绕开引号嵌套，不是为了保密。解码落盘再 chmod，nohup 起它。
      `echo ${shellQuote(runnerB64)} | base64 -d > ${shellQuote(`${dir}/runner.sh`)}`,
      `chmod +x ${shellQuote(`${dir}/runner.sh`)}`,
      // setsid 断开控制终端，任务不会因为调用方 shell 关闭而收到 SIGHUP。
      `nohup setsid ${shellQuote(`${dir}/runner.sh`)} > ${shellQuote(`${dir}/log`)} 2>&1 < /dev/null &`,
      `echo $! > ${shellQuote(`${dir}/pid`)}`,
    ].join('\n');

    const r = await session.exec(bootstrap, { timeout: 20000 });
    if (r.code !== 0) {
      throw new Error(`任务未能启动（退出码 ${r.code}）：${r.stderr.trim() || r.stdout.trim()}`);
    }

    // 起没起来要确认：mkdir 成功但 nohup 那步静默失败的话，只看退出码会误报成功。
    const probe = await session.exec(
      `test -f ${shellQuote(`${dir}/pid`)} && cat ${shellQuote(`${dir}/pid`)} || echo __NOPID__`,
      { timeout: 10000 },
    );
    const pid = probe.stdout.trim();
    if (!pid || pid === '__NOPID__') {
      throw new Error(`任务目录已建但没拿到 pid，看 ${dir}/log：${r.stderr.trim()}`);
    }

    return text({
      jobId,
      pid,
      label: name ?? null,
      command,
      cwd: cwd ? resolvePath(cwd) : CONFIG.baseDir,
      dir,
      check: `用 remote_job_check 查，jobId=${jobId}`,
    });
  },

  async remote_job_check({ jobId, tail }) {
    if (!jobId) throw new Error('jobId 不能为空');
    if (!/^[\w-]+$/.test(jobId)) throw new Error(`jobId 格式不对：${jobId}`);

    const dir = `${JOBS_DIR}/${jobId}`;
    const n = Math.max(1, Math.min(Number(tail) || 40, 500));

    // 一次 exec 拿全所有信息。分开查要三次往返（meta/exit/log 各一次），
    // 而这正是后台任务的价值——省往返。
    //
    // 进程存活判断也在同一次 exec 里做完（kill -0），否则还要再发一次。
    //
    // 整段脚本走 base64：$d 这种变量在单引号里会安全，但 \0 转义、\n 之类
    // 在多层引号里容易走形，base64 传输后再解出来执行就没有这些坑。
    const script = [
      'd=$1',
      'n=$2',
      'if [ ! -d "$d" ]; then echo __NOJOB__; exit 0; fi',
      'printf "STATUS="',
      // exit 文件是终态的权威标志：它是子进程跑完才写的。
      'if [ -f "$d/exit" ]; then cat "$d/exit"; else echo running; fi',
      'printf "PID="; cat "$d/pid" 2>/dev/null || echo "?"',
      'printf "ALIVE="',
      'p=$(cat "$d/pid" 2>/dev/null)',
      'if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo 1; else echo 0; fi',
      'printf "STARTED="; tr "\\0" "\\n" < "$d/meta" 2>/dev/null | sed -n 1p',
      // elapsed 在这里算，不在本地减：两端时钟不同步（实测远端快约 1 秒），
      // 本地用 Date.now() 减远端时间戳会得到负数。
      'printf "ELAPSED="',
      't0=$(tr "\\0" "\\n" < "$d/meta" 2>/dev/null | sed -n 1p)',
      'case "$t0" in ""|*[!0-9]*) echo "?" ;; *) echo $(( $(date +%s) - t0 )) ;; esac',
      'printf "TAIL\\n"; tail -n "$n" "$d/log" 2>/dev/null',
    ].join('\n');
    const b64 = Buffer.from(script, 'utf8').toString('base64');

    const r = await session.exec(
      `echo ${shellQuote(b64)} | base64 -d | bash -s -- ${shellQuote(dir)} ${n}`,
      { timeout: 15000 },
    );

    const out = r.stdout;
    if (out.trim() === '__NOJOB__') {
      throw new Error(`没有这个任务：${jobId}（可能已被清理，或 id 写错了）`);
    }

    const exitCode = out.match(/^STATUS=(\d+)/m)?.[1];
    const pid = out.match(/^PID=(.*)$/m)?.[1]?.trim();
    const alive = out.match(/^ALIVE=(\d)$/m)?.[1] === '1';
    const started = out.match(/^STARTED=(.*)$/m)?.[1]?.trim();
    const elapsed = out.match(/^ELAPSED=(-?\d+)$/m)?.[1];
    const body = out.replace(/^STATUS=.*\nPID=.*\nALIVE=.*\nSTARTED=.*\nELAPSED=.*\nTAIL\n/m, '');

    let status;
    if (exitCode !== undefined) status = exitCode === '0' ? 'done' : 'failed';
    else if (alive) status = 'running';
    else status = 'vanished'; // 进程和 exit 文件都不在了：被 kill 掉或机器重启

    return text({
      jobId,
      status,
      exitCode: exitCode === undefined ? null : Number(exitCode),
      pid,
      startedAt: started && started !== '?' ? new Date(Number(started) * 1000).toISOString() : null,
      elapsedSec: elapsed === undefined ? null : Number(elapsed),
      log: body.trim() ? body.trimEnd() : null,
      note: status === 'vanished'
        ? '进程不在了也没有退出码文件 —— 多半被 kill 或机器重启，日志末尾或许有线索'
        : status === 'running' ? '还在跑，稍后再查一次' : null,
    });
  },

  async remote_job_list({ all }) {
    // 一次 exec 拿全部任务的状态，不为每个任务单发一次请求——N 个任务就是 N 倍往返，
    // 而这工具存在的意义就是省往返。逐个 taskId 远端 for 循环比在本地发 N 次快得多。
    const r = await session.exec(
      [
        `root=${shellQuote(JOBS_DIR)}`,
        'for d in "$root"/*/; do',
        '  [ -d "$d" ] || continue',
        '  id=$(basename "$d")',
        '  if [ -f "$d/exit" ]; then c=$(cat "$d/exit");',
        // 退出码要翻成状态词。直接拿数字当状态会让人以为 status 是个错误等级。
        '    if [ "$c" = 0 ]; then st=done; else st=failed; fi',
        '  else',
        '    p=$(cat "$d/pid" 2>/dev/null)',
        '    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then st=running; else st=vanished; fi',
        '  fi',
        // meta 的四段用 NUL 分隔。读它不能靠 cut -d"\0"：bash 不对 cut 的参数做
        // 转义解释，cut -d"\0" 里的 \0 是两个字符，切不开（实测 label 永远读成空）。
        // tr 把 NUL 换成换行后用 sed 取第几段，稳。
        '  t0=$(tr "\\0" "\\n" < "$d/meta" 2>/dev/null | sed -n 1p)',
        // t0 可能为空（meta 写坏/正在写），此时算术展开会报语法错。
        '  case "$t0" in ""|*[!0-9]*) el=? ;; *) el=$(( $(date +%s) - t0 )) ;; esac',
        '  lbl=$(tr "\\0" "\\n" < "$d/meta" 2>/dev/null | sed -n 4p | tr "\\n\\t" "  " | tr -d "|")',
        // 字段用竖线拼，但先把 label 与日志行里的竖线和换行换掉——否则
        // 一条日志里出现 | 就会让列错位（bash printf 不支持 \x 转义，
        // 曾经想用 \x1f 作分隔符，实测 printf 原样输出四个字符，不生效）。
        '  last=$(tail -n 1 "$d/log" 2>/dev/null | tr -d "\\r" | tr "\\n\\t" "  " | cut -c1-60 | tr -d "|")',
        '  printf "%s|%s|%s|%s|%s\\n" "$id" "$st" "$el" "$lbl" "$last"',
        'done',
      ].join('\n'),
      { timeout: 15000 },
    );

    const rows = r.stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, st, el, lbl, last] = line.split('|');
        return { id, st, el, lbl, last };
      })
      // 倒序即时间倒序：jobId 以 base36 时间戳开头。
      .reverse();

    if (rows.length === 0) {
      return text('没有任何后台任务。用 remote_exec_bg 起一个。');
    }

    const shown = all ? rows : rows.filter((x) => x.st === 'running');
    if (shown.length === 0) {
      return text(`共 ${rows.length} 个任务，但都在跑之外的终态。传 all: true 可看全部。`);
    }
    // 远端脚本里已经算好 elapsed 直接输出，这里不再用本地时间减——
    // 两端时钟不同步（实测远端快约 1 秒），减出来会差甚至为负。
    const body = shown.map(({ id, st, el, lbl, last }) => {
      const secs = el && el !== '?' ? `${el}s` : '?';
      return `${id}  ${String(st).padEnd(9)} ${secs.padStart(7)}  ${lbl || '(无标签)'}`
        + (last ? `  | ${last}` : '');
    }).join('\n');
    return text(`共 ${rows.length} 个任务，显示 ${shown.length} 个：\n${body}`);
  },
};

const server = new Server(
  { name: 'ssh-remote', version: '1.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params ?? {};
  const handler = handlers[name];
  if (!handler) return failRes(new Error(`未知工具: ${name}`));
  try {
    return await handler(args ?? {});
  } catch (e) {
    // 连接类错误自动重连一次再告诉调用方
    const isConn = /ECONNRESET|EPIPE|not connected|socket/i.test(e?.message ?? '');
    if (isConn) {
      try {
        await session.reconnect();
        return await handler(args ?? {});
      } catch (e2) {
        return failRes(e2);
      }
    }
    return failRes(e);
  }
});

process.on('SIGINT', () => { session.close(); process.exit(0); });
process.on('SIGTERM', () => { session.close(); process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[ssh-remote] MCP server 已就绪 target=${CONFIG.username}@${CONFIG.host} base=${CONFIG.baseDir}`);
