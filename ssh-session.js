/**
 * 常驻 SSH 会话：一条 TCP 连接上开多个 channel，避免每次调用都重新握手。
 *
 * 为什么不用 ssh.ControlMaster：Windows 上的两个 ssh 实现都不支持 multiplexing
 * （Git-MSYS 报 mux_client_request_session: read from master failed ；
 *  Win32-OpenSSH 报 getsockname failed: Not a socket）。
 * 这里用 ssh2 在 Node 进程内自己维护连接，效果等价且可控。
 *
 * 安全边界：目标主机在构造时固定，不由调用方参数决定。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ssh2pkg from 'ssh2';

const { Client } = ssh2pkg;

export function shellQuote(s) {
  if (s === '' || s === undefined || s === null) return "''";
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function truncate(str, maxBytes, label) {
  if (Buffer.byteLength(str) <= maxBytes) return { text: str, truncated: false };
  // 按字节切，可能切在多字节字符中间，replacement char 会显形但不会崩
  const buf = Buffer.from(str, 'utf8').subarray(0, maxBytes);
  return {
    text: buf.toString('utf8') + `\n\n…[${label}超过 ${maxBytes} 字节，已截断]`,
    truncated: true,
  };
}

export class RemoteSession {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port ?? 22;
    this.username = opts.username;
    this.keyPath = opts.keyPath ?? path.join(os.homedir(), '.ssh', 'id_ed25519');
    this.readyTimeout = opts.readyTimeout ?? 20000;
    this.keepaliveInterval = opts.keepaliveInterval ?? 15000;
    this.keepaliveCountMax = opts.keepaliveCountMax ?? 3;

    this.conn = null;
    this.disposed = true;
    this.lastError = null;
    this._connecting = null;
    this._sftp = null;
  }

  get isConnected() {
    return Boolean(this.conn) && !this.disposed;
  }

  /** 幂等：已连则直接返回；并发调用共享同一个建连 Promise */
  ensure() {
    if (this.isConnected) return Promise.resolve(this.conn);
    if (this._connecting) return this._connecting;
    this._connecting = this._connect().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      let key;
      try {
        key = fs.readFileSync(this.keyPath);
      } catch (e) {
        reject(new Error(`读私钥失败 ${this.keyPath}: ${e.message}`));
        return;
      }

      const conn = new Client();
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch { /* 忽略 */ }
        reject(new Error(`SSH 建连超时（${this.readyTimeout}ms） host=${this.host}`));
      }, this.readyTimeout);

      conn.on('ready', () => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        this.conn = conn;
        this.disposed = false;
        this.lastError = null;
        resolve(conn);
      });

      conn.on('error', (err) => {
        this.lastError = err;
        this._teardown();
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          reject(err);
        }
      });

      conn.on('close', () => {
        this._teardown();
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          reject(this.lastError ?? new Error('SSH 连接在就绪前就被关闭'));
        }
      });

      conn.connect({
        host: this.host,
        port: this.port,
        username: this.username,
        privateKey: key,
        readyTimeout: this.readyTimeout,
        keepaliveInterval: this.keepaliveInterval,
        keepaliveCountMax: this.keepaliveCountMax,
      });
    });
  }

  _teardown() {
    this.disposed = true;
    this.conn = null;
    this._sftp = null;
  }

  /** 主动断开并重连，用于出错后手动恢复 */
  async reconnect() {
    try {
      if (this.conn) this.conn.end();
    } catch { /* 忽略 */ }
    this._teardown();
    return this.ensure();
  }

  /**
   * 在远端执行命令。cwd 存在时自动前置 cd。
   * 返回 { stdout, stderr, code, signal, timedOut, truncated }
   */
  async exec(command, options = {}) {
    const { timeout = 120000, maxBytes = 1024 * 1024, cwd } = options;
    const conn = await this.ensure();
    const cmd = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;

    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let done = false;

        const finish = (payload) => {
          if (done) return;
          done = true;
          clearTimeout(killTimer);
          clearTimeout(hardTimer);
          resolve(payload);
        };

        const bump = (cur, chunk) => {
          if (truncated) return cur;
          const next = cur + chunk;
          if (Buffer.byteLength(next) > maxBytes) {
            truncated = true;
            return truncate(next, maxBytes, '输出').text;
          }
          return next;
        };

        const killTimer = setTimeout(() => {
          timedOut = true;
          try { stream.signal('KILL'); } catch { /* 忽略 */ }
        }, timeout);

        // 兜底：万一 KILL 也没能关掉 channel，别让调用方永久挂起
        const hardTimer = setTimeout(() => {
          finish({
            stdout, stderr, code: null, signal: 'KILL',
            timedOut, truncated,
            bailout: `执行超过 ${timeout}ms 宽限期仍未退出`,
          });
        }, timeout + 5000);

        stream.on('data', (d) => { stdout = bump(stdout, d.toString('utf8')); });
        stream.stderr.on('data', (d) => { stderr = bump(stderr, d.toString('utf8')); });

        stream.on('close', (code, signal) => {
          const out = truncate(stdout, maxBytes, 'stdout');
          const err2 = truncate(stderr, maxBytes, 'stderr');
          finish({
            stdout: out.text,
            stderr: err2.text,
            code: typeof code === 'number' ? code : null,
            signal: signal ?? null,
            timedOut,
            truncated: truncated || out.truncated || err2.truncated,
          });
        });

        stream.on('error', (e) => {
          clearTimeout(killTimer);
          clearTimeout(hardTimer);
          if (!done) { done = true; reject(e); }
        });
      });
    });
  }

  async sftp() {
    const conn = await this.ensure();
    if (this._sftp) return this._sftp;
    this._sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    return this._sftp;
  }

  /** 读文件，超出 maxBytes 截断。二进制文件会按 utf8 强行解码，够用。 */
  async readFile(remotePath, { maxBytes = 512 * 1024 } = {}) {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let stopped = false;
      const stream = sftp.createReadStream(remotePath, { autoClose: true });

      stream.on('data', (d) => {
        if (stopped) return;
        chunks.push(d);
        total += d.length;
        if (total >= maxBytes) {
          stopped = true;
          try { stream.close(); } catch { /* 忽略 */ }
        }
      });
      stream.on('error', (e) => reject(e));
      stream.on('close', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        const t = truncate(text, maxBytes, '文件');
        resolve({ path: remotePath, content: t.text, bytes: buf.length, truncated: t.truncated });
      });
      stream.on('end', () => { /* 依赖 close */ });
    });
  }

  async writeFile(remotePath, content, { mode } = {}) {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath, { autoClose: true, ...(mode ? { mode } : {}) });
      stream.on('error', (e) => reject(e));
      stream.on('close', () => resolve({ path: remotePath, bytes: Buffer.byteLength(content ?? '', 'utf8') }));
      stream.end(content ?? '');
    });
  }

  async readdir(remotePath, { maxEntries = 500 } = {}) {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        const items = list.slice(0, maxEntries).map((e) => ({
          name: e.filename,
          type: e.attrs.isDirectory() ? 'dir' : e.attrs.isSymbolicLink() ? 'link' : 'file',
          size: e.attrs.size,
          mtime: e.attrs.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null,
          mode: e.attrs.mode ? (e.attrs.mode & 0o777).toString(8) : null,
        })).sort((a, b) => {
          if (a.type === 'dir' && b.type !== 'dir') return -1;
          if (a.type !== 'dir' && b.type === 'dir') return 1;
          return a.name.localeCompare(b.name);
        });
        resolve({ path: remotePath, entries: items, total: list.length, truncated: list.length > maxEntries });
      });
    });
  }

  async stat(remotePath) {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, attrs) => {
        if (err) return reject(err);
        resolve({
          path: remotePath,
          exists: true,
          type: attrs.isDirectory() ? 'dir' : attrs.isSymbolicLink() ? 'link' : 'file',
          size: attrs.size,
          mtime: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null,
          mode: attrs.mode ? (attrs.mode & 0o777).toString(8) : null,
        });
      });
    });
  }

  close() {
    try {
      if (this.conn) this.conn.end();
    } catch { /* 忽略 */ }
    this._teardown();
  }
}
