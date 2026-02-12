# Baton

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org/)

连接 IM 与本地 ACP Agent 的智能代理桥梁。

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
| **CLI**         | ✅ 已支持 | 本地命令行交互             |
| **Slack**       | 🔮 计划中 | -                          |
| **Discord**     | 🔮 计划中 | -                          |

## 支持的 Executor

Baton 基于 [ACP 协议](https://agentclientprotocol.org/)，目前支持以下 ACP Runtime：

| Runtime      | 命令           | 说明                            |
| ------------ | -------------- | ------------------------------- |
| **opencode** | `opencode acp` | 默认，需全局安装 `opencode` CLI |
| **codex**    | `codex-acp`    | 需可执行的 `codex-acp` 命令     |
| **claude**   | `claude-code-acp` | 需可执行的 `claude-code-acp` 命令 |

> ACP 是开放协议，未来将支持更多兼容 ACP 的 Runtime。

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
```

### 2. 启动

```bash
# 飞书模式
baton feishu

# CLI 模式
baton cli
```

## 使用指令

| 指令        | 说明                 |
| ----------- | -------------------- |
| `/help`     | 显示帮助             |
| `/current`  | 查看会话状态         |
| `/stop all` | 停止所有任务         |
| `/reset`    | 重置会话             |
| 任意文本    | 发送 Prompt 给 Agent |

## License

Apache 2.0 © Baton Contributors
