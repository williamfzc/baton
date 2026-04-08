# Baton

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org/)

连接 IM 与本地 ACP Agent 的智能代理桥梁。

[English README](README.md)

## 安装

### 推荐路径

第一次使用时，按下面 4 步走最不容易绕：

1. 安装 Baton
2. 确认 `baton` 命令可用
3. 安装一个 ACP Runtime
4. 写一个最小配置文件，然后先用飞书启动

### 1. 安装 Baton

```bash
curl -fsSL https://raw.githubusercontent.com/williamfzc/baton/main/install.sh | bash
```

安装脚本会自动：

- 检测系统和架构
- 下载最新 release
- 安装到 `XDG_BIN_HOME`（若已设置）或 `~/.local/bin`

无需 `sudo`。

### 2. 确认安装路径

安装完成后，先执行：

```bash
baton --help
```

如果提示找不到命令，通常是因为安装目录还没加入 PATH。把下面这行加入 shell 配置文件（如 `~/.zshrc`）：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 3. 安装 ACP Runtime

Baton 本身是桥梁，还需要一个 ACP Runtime 才能真正执行任务。

当前支持：

- `opencode`：默认使用 `opencode acp`
- `codex`：使用 `codex-acp`
- `claude-code`：使用 `claude-code-acp`

如果你已经安装了 `opencode`，通常不需要额外配置 executor；否则可以在配置文件里切换。

为避免找不到安装入口，建议直接使用下列官方仓库：

- Codex ACP: https://github.com/zed-industries/codex-acp
- Claude Code ACP: https://github.com/zed-industries/claude-code-acp

安装完成后请确认命令可用：

```bash
opencode acp --help
codex-acp --help
claude-code-acp --help
```

### 4. 写配置文件

推荐在你的项目根目录创建 `baton.config.json`。

Baton 默认会从当前目录开始，向上最多查找 5 层这些文件名：

- `baton.config.json`
- `.batonrc.json`
- `baton.json`

如果你更想把配置放在别的位置，也可以在启动时显式指定：

```bash
baton --config /absolute/path/to/baton.config.json feishu
```

第一次使用时，建议先用下面这个最小配置，以飞书作为默认 channel：

```json
{
  "project": {
    "path": "/path/to/your/project",
    "name": "my-project"
  },
  "language": "zh-CN",
  "feishu": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "domain": "feishu"
  },
  "acp": {
    "executor": "opencode"
  }
}
```

这里最需要替换的只有 4 个值：

- `project.path`：你的本地项目绝对路径
- `project.name`：这个项目在 Baton 里的显示名称
- `feishu.appId`：飞书应用 App ID
- `feishu.appSecret`：飞书应用 App Secret

如果你不想把密钥写进文件，推荐改用环境变量：

```bash
export BATON_FEISHU_APP_ID=cli_xxx
export BATON_FEISHU_APP_SECRET=xxx
export BATON_EXECUTOR=opencode
```

### 5. 先用飞书启动

```bash
baton feishu
```

如果配置文件里已经有 `feishu.appId` 和 `feishu.appSecret`，也可以直接运行：

```bash
baton
```

此时会自动进入飞书模式。

如果你只是想先验证本地链路是否正常，也可以先用 CLI 模式：

```bash
baton cli
```

### 其他安装方式

从 [Releases](https://github.com/williamfzc/baton/releases) 下载对应平台的二进制文件：

- `baton-linux-x64`
- `baton-darwin-x64`（Intel）
- `baton-darwin-arm64`（Apple Silicon）

```bash
chmod +x baton-*
mkdir -p ~/.local/bin
mv baton-* ~/.local/bin/baton
```

### 从源码运行

```bash
git clone https://github.com/williamfzc/baton.git
cd baton
bun install
bun run start:cli
```

## 支持的 IM 平台

| 平台            | 状态      | 说明                       |
| --------------- | --------- | -------------------------- |
| **飞书 / Lark** | ✅ 已支持 | WebSocket 长链接，内网可用 |
| **Telegram**    | ✅ 已支持 | Bot API 长轮询             |
| **WhatsApp**    | ✅ 已支持 | Webhook + Graph API        |
| **Slack**       | ✅ 已支持 | Events API Webhook         |
| **CLI**         | ✅ 已支持 | 本地命令行交互             |
| **Discord**     | 🔮 计划中 | -                          |

## 支持的 Executor

Baton 基于 [ACP 协议](https://agentclientprotocol.org/)，目前支持以下 ACP Runtime：

| Runtime      | 命令              | 说明                                |
| ------------ | ----------------- | ----------------------------------- |
| **opencode** | `opencode acp`    | 默认，需全局安装 `opencode` CLI     |
| **codex**    | `codex-acp`       | 需可执行的 `codex-acp` 命令         |
| **claude**   | `claude-code-acp` | 需可执行的 `claude-code-acp` 命令   |

> ACP 是开放协议，未来将支持更多兼容 ACP 的 Runtime。

## 快速开始

### 1. 配置参考（完整版）

创建 `baton.config.json`：

```json
{
  "project": {
    "path": "/path/to/your/project",
    "name": "my-project"
  },
  "language": "zh-CN",
  "feishu": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "domain": "feishu"
  },
  "telegram": {
    "botToken": "123456:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "whatsapp": {
    "permissionTimeout": 300,
    "wacli": {
      "bin": "wacli",
      "storeDir": "~/.wacli",
      "pollIntervalMs": 2000
    }
  },
  "slack": {
    "botToken": "xoxb-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "signingSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "port": 8081,
    "webhookPath": "/webhook/slack"
  },
  "acp": {
    "executor": "opencode"
  }
}
```

### 1.1 自定义 ACP 启动命令（可选）

如果你希望 Baton 启动自定义 ACP 进程（例如指定二进制路径或参数），可以在配置里增加 `acp.command`：

```json
{
  "acp": {
    "executor": "codex",
    "command": "codex-acp",
    "args": [],
    "cwd": ".",
    "env": {
      "OPENAI_API_KEY": "sk-***"
    }
  }
}
```

- `executor`：用于选择默认内置命令（`opencode`/`codex`/`claude-code`）
- `command` + `args`：填写后会覆盖默认命令
- `cwd`：ACP 进程工作目录；相对路径基于当前仓库根目录
- `env`：仅注入给 ACP 子进程的环境变量

也可以直接用环境变量切换 executor：

```bash
export BATON_EXECUTOR=codex
```

或使用环境变量（推荐用于敏感信息）：

```bash
export BATON_FEISHU_APP_ID=cli_xxx
export BATON_FEISHU_APP_SECRET=xxx
export BATON_TELEGRAM_BOT_TOKEN=123456:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export BATON_SLACK_BOT_TOKEN=xoxb-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export BATON_SLACK_SIGNING_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export BATON_SLACK_API_BASE=https://slack.com/api
export BATON_SLACK_PORT=8081
export BATON_SLACK_WEBHOOK_PATH=/webhook/slack
```

### 2. 启动

```bash
# 飞书模式
baton feishu

# Telegram 模式
baton telegram

# WhatsApp 模式
baton whatsapp

# Slack 模式
baton slack

# CLI 模式
baton cli

# 指定语言
baton --mode cli --lang zh-CN
```

## 使用指令

### 指令列表

| 指令 | 用法 | 说明 |
| --- | --- | --- |
| `/repo` | `/repo` | 列出可用仓库，并进入数字选择交互 |
| `/repo [序号/名称]` | `/repo 2` 或 `/repo my-repo` | 直接切换到目标仓库 |
| `/current` | `/current` | 查看当前会话、队列与任务状态 |
| `/stop` | `/stop` | 停止当前任务 |
| `/stop [id]` | `/stop 3` | 停止指定任务 |
| `/stop all` | `/stop all` | 停止当前任务并清空队列 |
| `/reset` | `/reset` | 重置当前会话（清除上下文） |
| `/new` | `/new` | `/reset` 的别名 |
| `/mode` | `/mode` | 打开 Mode 选择（数字交互） |
| `/mode [name]` | `/mode code` | 直接切换 Agent Mode |
| `/model` | `/model` | 打开 Model 选择（数字交互） |
| `/model [name]` | `/model gpt-5` | 直接切换模型 |
| `/help` | `/help` | 显示帮助信息 |
| 任意非指令文本 | `帮我修这个 bug` | 作为 Prompt 转发给 ACP Agent |

### 指令使用说明

- 所有以 `/` 开头但不在上表中的内容，也会按普通 Prompt 转发给 Agent。
- 当系统要求确认权限或选择项时，优先使用数字回复（`1`、`2`...）。
- 也支持文本回复：`allow` / `deny` / `cancel` / `yes` / `no` / `y` / `n`，或直接输入选项名。

## License

Apache 2.0 © Baton Contributors
