# rconsole

跨平台远程控制台服务器（**只实现 server 端**）。它安装在被操作的机器上（**Windows 为主**，Linux 同样可用），操作方用现成的 `telnet` 或 `nc`（裸 TCP）连上来即可，**不需要任何自定义客户端**。

三种能力：

| 模式 | 默认端口 | 用途 | 客户端示例 |
|------|---------|------|-----------|
| `shell` | 9000 | 交互式**自由 shell**（cmd.exe / powershell / bash） | `telnet host 9000` |
| `exec` | 9001 | 一次性执行任意命令 | `echo 'ipconfig' \| nc host 9001` |
| `service` | 9002 | 执行 server 端**预设服务** | `echo 'status' \| nc host 9002` |

典型场景：把一台 Windows PC 当作远程运维跳板，操作方远程连上来，在自由 shell 里跑 `ssh`、`plink`、`python -m serial.tools.miniterm COM3 115200` 等，去操作连接在这台 PC 上的设备。

---

## 环境要求

- **服务器主机**：Node.js ≥ 18；Windows 10 1809+（node-pty 使用 ConPTY）。Linux/macOS 任意较新版本。
- **操作方**：任意系统，只要有 `telnet`、`nc` 或 PuTTY 即可。

## 安装

### 1. 安装 Node.js（≥ 18）

- **Windows**：到 [nodejs.org](https://nodejs.org/) 下载 LTS 版 `.msi` 安装包，双击一路 Next 即可（自带 npm）。装完新开一个 PowerShell 或 cmd 窗口。
- **Linux**：用包管理器或 [nvm](https://github.com/nvm-sh/nvm) 安装，例如 Ubuntu/Debian：`sudo apt install -y nodejs npm`。

### 2. 安装依赖

把本项目目录放到目标机器（Windows 上例如 `C:\rconsole`），进入目录执行：

```powershell
git clone https://github.com/haode01/rconsole.git
cd rconsole
npm install
```

`node-pty` 带有主流平台/Node 版本的预编译二进制（prebuild），通常无需编译。若你的 Node 版本没有匹配的预编译包，会退回到本地编译：

- **Windows**：先安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/)（勾选 "Desktop development with C++"），再执行 `npm install`。
- **Linux**：需要 `make`、`g++`、`python3`。

### 3. 启动

```powershell
# Windows：使用 Windows 预设服务配置（Git Bash / PowerShell / cmd 均可用）
node bin/rconsole.js --config config.windows.example.json

# Linux：使用通用示例配置
node bin/rconsole.js --config config.example.json
```

> Windows 下想让其常驻、开机自启，见下文「做成 Windows 服务」。

## 快速开始

```bash
# 用默认配置（9000 shell / 9001 exec / 9002 service）
node bin/rconsole.js

# 或指定端口 / 配置文件
node bin/rconsole.js --port 9000 --exec-port 9001 --service-port 9002
node bin/rconsole.js --config ./config.example.json          # 通用示例
node bin/rconsole.js --config ./config.windows.example.json  # Windows 预设服务示例
node bin/rconsole.js --shell powershell.exe   # 切换 Windows shell
```

查看完整参数：`node bin/rconsole.js --help`。

## 使用（操作方）

```bash
# 1) 交互式 shell
telnet <host> 9000

# 2) 一次性命令（干净输出，无提示符残留）
echo 'ipconfig /all' | nc <host> 9001     # Windows 命令
echo 'ifconfig'      | nc <host> 9001     # Linux 命令

# 3) 预设服务
echo 'status' | nc <host> 9002            # 执行预设服务 status
echo 'list'   | nc <host> 9002            # 列出所有预设服务
echo 'echo hello world' | nc <host> 9002  # 给服务传参数
```

Windows 下没有 `nc` 时，可用 PuTTY（选择 Telnet 协议）连 shell 端口，或用 Git Bash 自带的 `nc`。

## 配置

配置文件示例：

- [`config.example.json`](config.example.json) — 通用示例（含少量示例服务）。
- [`config.windows.example.json`](config.windows.example.json) — Windows 专用示例，内置一组常用 Windows 预设服务（`ipconfig`、`systeminfo`、`tasklist`、`ping`、`reboot`、`serial`、`ssh` 等）。

要点：

- `listeners`：可配置任意多个监听器，每个指定 `mode`（`shell` / `exec` / `service`）、`host`、`port`。
- `shell`：`windows`/`linux` 分别指定 shell 可执行文件与参数；`codepageUtf8: true` 会在 Windows 上先执行 `chcp 65001` 统一 UTF-8。
- `exec`：一次性执行的输入上限与超时。
- `services`：预设服务列表。
- `auth`：可选认证（默认关闭）。
- `log`：可选日志文件。

### 预设服务

每个服务是一个「名字 → 命令」的映射：

```jsonc
{
  "name": "status",
  "description": "Show system info",
  "command": "systeminfo",
  "args": { "min": 0, "max": 0 },
  "timeoutSeconds": 10,
  "hidden": false
}
```

- `command` 为**字符串**时经 shell 执行（Windows `cmd /c`，Linux `sh -c`）；占位符 `{args}` 会被客户端参数替换，没有 `{args}` 则把参数追加到命令末尾。
- `command` 为**数组**时不经 shell 直接 `spawn`（更安全，推荐敏感服务使用）：元素等于 `"{args}"` 会展开为参数列表，其它元素里的 `{args}` 子串被替换。
- `args.min/max` 限制参数个数；`timeoutSeconds` 超时强杀；`hidden: true` 不在 `list` 里显示。
- 内置伪服务 `list` / `help` / `?` 用于查看可用服务。
- **`pty: true`**：让该服务运行在**真实终端（TTY）**里，连接变为交互式（适合 `ssh`、串口控制台等需要终端的前台程序）。默认 `false` 为一次性管道执行（无 TTY）。

```jsonc
// 参数占位示例
{ "name": "ssh-dev", "command": "ssh {args}", "args": { "min": 1, "max": 16 }, "pty": true }
// 数组形式（不经 shell，避免注入）
{ "name": "ping1", "command": ["ping", "-n", "4", "{args}"], "args": { "min": 1, "max": 1 } }
```

### 交互式服务 vs 一次性服务

- **一次性服务**（默认，`pty: false`）：`echo 'systeminfo' | nc <host> 9002` 跑完即断开，返回 `[exit: N]`。**没有 TTY**，所以 `ssh` 会报 `Pseudo-terminal will not be allocated because stdin is not a terminal`。
- **交互式服务**（`pty: true`）：连上后输入 `服务名 参数` 回车，之后这个连接就**全程粘在**该命令上，可交互输入（输密码、进设备命令行、tab 补全）。用法：

  ```bash
  telnet <host> 9002          # 或 nc <host> 9002 / PuTTY(Telnet)
  ssh root@192.168.1.1        # 服务名 ssh + 参数，回车后进入交互式 ssh
  ```

  要退出交互式服务，直接结束该命令（如 ssh 里 `exit`）或关闭连接即可。

## 认证（可选，默认关闭）

```bash
node bin/rconsole.js --auth 'my-secret-token'
```

开启后，所有连接会先提示 `Password:`，输入匹配的 token 才放行。也可以用配置文件的 `auth.enabled` + `auth.token`。

> 密码在输入时**不会**关闭回显（明文 TCP 下本无加密意义）；仅作为内网里的简单门禁。

## 中文 / 编码

- Windows 下默认开启 `codepageUtf8`，会在 shell 启动时执行 `chcp 65001`，使 cmd/PowerShell 输出统一为 UTF-8，避免中文乱码。
- 若个别程序仍按 OEM 代码页（GBK）输出，请在该程序内切换到 UTF-8，或关闭 `codepageUtf8` 让终端按本机代码页解释。

## 安全提示

- 默认**无认证、明文 TCP**。请只在**内网 / VPN / 可信网络**中使用，或自行加上 TLS 反代（如 nginx/stunnel）。
- 自由 shell 等于把远程执行权限交给任何能连上该端口的人，务必用防火墙限制来源地址。
- 服务若用字符串 `command`，客户端参数会经 shell 拼接，存在命令注入面；对敏感服务请改用**数组**形式。

## 做成 Windows 服务（开机自启）

用 [NSSM](https://nssm.cc/) 或「任务计划程序」把 `node bin/rconsole.js --config <路径>` 注册为服务，让它在 Windows 上常驻。示例（NSSM）：

```bat
nssm install rconsole "C:\Program Files\nodejs\node.exe" "C:\path\to\rconsole\bin\rconsole.js --config C:\path\to\config.json"
nssm start rconsole
```

## 目录结构

```
rconsole/
├── bin/rconsole.js        # CLI 入口
├── src/
│   ├── config.js          # 配置加载/合并/校验
│   ├── telnet.js          # 最小 telnet IAC 协商/过滤
│   ├── session.js         # node-pty 双向桥接
│   ├── services.js        # 预设服务调度
│   └── server.js          # 三种监听模式 + 生命周期
├── test/                  # node:test 单测 + 集成测试
├── config.example.json            # 通用配置示例
└── config.windows.example.json    # Windows 预设服务配置示例
```

## 测试

```bash
npm test
```

## 范围外（可后续扩展）

TLS 加密、命令级权限/多 token、内置「串口→TCP 透传」「SSH 快捷转发」、服务交互式持久会话、单文件打包（pkg）。
