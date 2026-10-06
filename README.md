# ssh-remote

常驻 SSH 长连接的 MCP server。让 WorkBuddy / Cursor 这类 AI 编码工具**直接读写远端机器、执行远端命令**，而不是每次调用都新建一次 SSH 连接。

装上之后的效果，和「本地连上远程开发机干活」基本一致：搜代码、读文件、改文件、跑命令、跑长任务、TTY 交互，都在远端原生环境里完成。

## 为什么要它

Windows 上每次 `ssh host "cmd"` 的开销拆开看：

| 环节 | 耗时 |
|---|---|
| 创建新进程（疑似杀软实时扫描） | ~480ms |
| SSH 握手 | ~420ms |
| 网络往返（局域网 <1ms） | 可忽略 |

也就是说**真正的命令执行时间被开销完全淹没了**。而 Windows 上两个 ssh 实现都**不支持连接复用**：

- Git-MSYS：`mux_client_request_session: read from master failed: Connection reset by peer`
- Win32-OpenSSH：`getsockname failed: Not a socket`

所以 `~/.ssh/config` 里配 `ControlMaster` 是没用的。

本项目的解法：绕开 multiplexing，改成**一个常驻 Node 进程 hold 住一条 ssh2 连接**，通过 MCP 暴露工具。调用时不创建进程、不重新握手。

## 实测性能

同刻对照，Windows 本机：

| 方式 | 一次典型四步信息收集¹ |
|---|---|
| `ssh` 命令行（4 次调用） | 3339ms |
| 本 MCP（4 次工具调用） | 177ms |

约 **19 倍**。单次调用：ssh 稳定 825ms，本MCP exec 50ms / search 52ms / list 82ms / read 8ms / stat 3ms。

> ¹ git 状态 + 代码搜索 + 读文件 + 健康检查

长连接会发心跳（15s × 3 次容错），跑完6 分钟的全量测试后健康检查仍是 14ms。首连含建连226ms，属一次性成本。

## 安装

```bash
npm install
```

在 MCP 客户端的配置里注册（WorkBuddy 是 `~/.workbuddy/mcp.json`）：

```json
{
  "mcpServers": {
    "ssh-remote": {
      "command": "node",
      "args": ["<绝对路径>/ssh-remote/server.js"],
      "env": {
        "SSH_REMOTE_HOST": "192.168.0.110",
        "SSH_REMOTE_USER": "yourname",
        "SSH_REMOTE_BASE": "/home/yourname/work/yourproject"
      }
    }
  }
}
```

必填 `SSH_REMOTE_HOST` / `SSH_REMOTE_USER` / `SSH_REMOTE_BASE`；不填会在启动时直接报错并告诉你怎么配，而不是拿着空主机名去连、报一堆看不懂的 ssh 错误。

新 server 需要在客户端的连接器管理里 Trust，并**重启客户端**才会加载。

### Windows + Git Bash 的坑

在 Git Bash 里手动跑验证脚本时，MSYS 会把环境变量值里的 Unix 路径改写成 Windows 路径：

```bash
# ✗ SSH_REMOTE_BASE 传进 node 后变成了 C:/Program Files/Git/home/... → "No such file"
SSH_REMOTE_BASE=/home/me/proj node smoke-test.js

# ✓
MSYS_NO_PATHCONV=1 SSH_REMOTE_BASE=/home/me/proj node smoke-test.js
```

走 MCP 配置（JSON）启动不受影响——那条路径不经过 shell。

## 配置

| 变量 | 必填 | 说明 |
|---|---|---|
| `SSH_REMOTE_HOST` | ✅ | 目标主机地址 |
| `SSH_REMOTE_PORT` | | SSH 端口，默认 22 |
| `SSH_REMOTE_USER` | ✅ | 登录用户名 |
| `SSH_REMOTE_KEY` | | 私钥路径，默认 `~/.ssh/id_ed25519` |
| `SSH_REMOTE_BASE` | ✅ | 远端工作目录，**必须是绝对路径** |
| `SSH_REMOTE_HOME` | | `~` 展开的基准，默认 `/home/$SSH_REMOTE_USER` |

> `SSH_REMOTE_BASE` 必须是绝对路径：它会被拼进远端 `cd "..."`，双引号里 `~` 不做展开。所有工具的相对路径都基于它。

**换机器**：改`env` 段，重启客户端。**多台机器并行**：复制一份目录，在配置里注册第二个条目、换个名字（工具前缀随之区分，如 `mcp__ssh-remote-2__*`）。同一台机器不需要多个 server。

**免密登录**：把公钥放进目标机`~/.ssh/authorized_keys`（`ssh-copy-id`）。

## 工具

| 工具 | 用途 |
|---|---|
| `remote_exec` | 执行远端命令。多条命令用 `&&` 串成一次调用更省——成本在调用次数，不在命令条数 |
| `remote_exec_bg` | 后台起长任务，立即返回 jobId，不阻塞 |
| `remote_job_check` | 查任务状态（`running` / `done` / `failed`）、退出码、耗时、日志尾部 |
| `remote_job_list` | 列出远端所有任务 |
| `remote_read` | 读远端文件（带行号） |
| `remote_write` | 写远端文件（整文件覆写） |
| `remote_replace` | 精确字符串替换，改文件不必整篇重写 |
| `remote_search` | 远端全文搜索（rg，跨连接复用） |
| `remote_find` | 按名找文件（fd） |
| `remote_list` | 列目录 |
| `remote_stat` | 文件元信息 |
| `remote_health` | 连接健康检查 |

### 后台长任务

长跑的东西（全量测试、构建、大批量迁移）不该占着 MCP 调用不放：

```js
remote_exec_bg({ command: "make test-db", label: "全量测试" })
// → { jobId: "muw9a36u-e6taf", pid: "2523963" }   约 250ms 返回

remote_job_check({ jobId: "muw9a36u-e6taf" })
// → { status: "done", exitCode: 0, durationMs: 226000, log: "..." }
```

状态全放**远端** `/tmp/ssh-remote-jobs/<jobId>/`，所以客户端重启也能继续查（内存状态会随进程消失，进度条就没意义了）。日志不会进 git，也不会被任何目录遍历工具扫到。

## 边界与取舍

- **没有 GUI diff 视图 / 变更文件面板**。原生 Read/Grep 只认本地路径，这是本机侧的限制。但`git diff` 本身能通过 `remote_exec` 完整拿到，AI 读文本足够。
- **改文件是整文件覆写或精确替换**，没有「光标停在某行」的细粒度编辑。对 AI 干活够用。
- **单条 TCP**：网络抖动会让正在跑的长命令直接失败（下一跳自动重连，但这一跳会报错）。长任务建议用 `remote_exec_bg`。
- **输出有上限**：命令 1MB、文件 512KB、目录 500 项，超出截断。
- **依赖远端有 `rg` / `fd`**：`remote_search` / `remote_find` 需要。没装会明确报错，退回 `grep` 也行，只是慢。

## TTY 交互

server 是非交互的，但远端有 tmux，所以 TTY 程序能跑：

```bash
tmux new-session -d -s htop htop
tmux capture-pane -pt htop     # 抓屏看内容
```

curses 程序、长跑任务中途看进度都适用。

## 验证改动

改完代码不必重启客户端就能验——探针会新建子进程加载最新代码：

```bash
node mcp-probe.js        # 跑通全部工具 + 后台任务三件套
node smoke-test.js       # 量化握手开销vs 连接复用
node bg-selftest.js      # 拿真实长任务验「起任务不阻塞」
```

## 安全边界

目标主机由 `CONFIG` 固定，**工具参数无法指定别的主机**——不提供任意目标跳转能力。stdout 专供 MCP 协议，所有日志走 stderr。
