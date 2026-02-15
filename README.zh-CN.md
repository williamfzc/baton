# Baton

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org/)

连接 IM 与本地 ACP Agent 的智能代理桥梁。

[English README](README.md)

## 安装

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/williamfzc/baton/main/install.sh | bash
```

安装脚本默认安装到用户目录：

- `XDG_BIN_HOME`（若已设置）
- 否则 `~/.local/bin`

无需 `sudo`。

### 手动安装

从 [Releases](https://github.com/williamfzc/baton/releases) 下载对应平台的二进制文件：

- `baton-linux-x64`
- `baton-darwin-x64`（Intel）
- `baton-darwin-arm64`（Apple Silicon）

```bash
chmod +x baton-*
mkdir -p ~/.local/bin
mv baton-* ~/.local/bin/baton
```

如果 `~/.local/bin` 不在 PATH 中，加入你的 shell 配置文件（如 `~/.zshrc`）：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 从源码运行

```bash
git clone https://github.com/williamfzc/baton.git
cd baton
bun install
bun run start:feishu
```

## 支持的 IM 平台

| 平台            | 状态      | 说明                       |
| --------------- | --------- | -------------------------- |
| **飞书 / Lark** | ✅ 已支持 | WebSocket 长链接，内网可用 |
| **Telegram**    | ✅ 已支持 | Bot API 长轮询             |
| **CLI**         | ✅ 已支持 | 本地命令行交互             |
| **Slack**       | 🔮 计划中 | -                          |
| **Discord**     | 🔮 计划中 | -                          |

## 支持的 Executor

Baton 基于 [ACP 协议](https://agentclientprotocol.org/)，目前支持以下 ACP Runtime：

| Runtime      | 命令              | 说明                                |
| ------------ | ----------------- | ----------------------------------- |
| **opencode** | `opencode acp`    | 默认，需全局安装 `opencode` CLI     |
| **codex**    | `codex-acp`       | 需可执行的 `codex-acp` 命令         |
| **claude**   | `claude-code-acp` | 需可执行的 `claude-code-acp` 命令   |

> ACP 是开放协议，未来将支持更多兼容 ACP 的 Runtime。

### ACP Runtime 安装链接

为避免找不到安装入口，建议直接使用下列官方仓库：

- Codex ACP: https://github.com/zed-industries/codex-acp
- Claude Code ACP: https://github.com/zed-industries/claude-code-acp

安装完成后请确认命令可用：

```bash
codex-acp --help
claude-code-acp --help
```

## 快速开始

### 1. 配置

创建 `baton.config.json`：

```json
{
  "project": {
    "path": "/path/to/your/project",
    "name": "my-project"
  },
  "feishu": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "domain": "feishu"
  },
  "telegram": {
    "botToken": "123456:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
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
```

### 2. 启动

```bash
# 飞书模式
baton feishu

# Telegram 模式
baton telegram

# CLI 模式
baton cli
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
