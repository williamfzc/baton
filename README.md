# Baton

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org/)

Intelligent agent bridge that connects IM channels with local ACP agents.

[中文 README](README.zh-CN.md)

## Installation

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/williamfzc/baton/main/install.sh | bash
```

Installs to:

- `XDG_BIN_HOME` if set
- otherwise `~/.local/bin`

No `sudo` required.

### Manual install

Download from [Releases](https://github.com/williamfzc/baton/releases):

- `baton-linux-x64`
- `baton-darwin-x64` (Intel)
- `baton-darwin-arm64` (Apple Silicon)

```bash
chmod +x baton-*
mkdir -p ~/.local/bin
mv baton-* ~/.local/bin/baton
```

Ensure `~/.local/bin` is in PATH (e.g. `~/.zshrc`):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Run from source

```bash
git clone https://github.com/williamfzc/baton.git
cd baton
bun install
bun run start:feishu
```

## Supported IM Platforms

| Platform     | Status | Notes                      |
| ------------ | ------ | -------------------------- |
| **Feishu**   | ✅     | WebSocket long-connection  |
| **Telegram** | ✅     | Bot API long polling       |
| **WhatsApp** | ✅     | Webhook + Graph API        |
| **Slack**    | ✅     | Events API webhook         |
| **CLI**      | ✅     | Local terminal interaction |
| **Discord**  | 🔮     | Planned                    |

## Supported Executors

Baton is based on the [ACP protocol](https://agentclientprotocol.org/) and currently supports:

| Runtime      | Command           | Notes                              |
| ------------ | ----------------- | ---------------------------------- |
| **opencode** | `opencode acp`    | Default, requires opencode CLI     |
| **codex**    | `codex-acp`       | Requires `codex-acp` in PATH       |
| **claude**   | `claude-code-acp` | Requires `claude-code-acp` in PATH |

### ACP Runtime Links

- Codex ACP: https://github.com/zed-industries/codex-acp
- Claude Code ACP: https://github.com/zed-industries/claude-code-acp

Verify commands:

```bash
codex-acp --help
claude-code-acp --help
```

## Quick Start

### 1. Configure

Create `baton.config.json`:

```json
{
  "project": {
    "path": "/path/to/your/project",
    "name": "my-project"
  },
  "language": "en",
  "feishu": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "domain": "feishu"
  },
  "telegram": {
    "botToken": "123456:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "whatsapp": {
    "accessToken": "EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "phoneNumberId": "123456789012345",
    "verifyToken": "whatsapp-verify-token",
    "apiBase": "https://graph.facebook.com/v20.0",
    "port": 8082,
    "webhookPath": "/webhook/whatsapp"
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

### 1.1 Custom ACP command (optional)

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

- `executor`: select default command (`opencode` / `codex` / `claude-code`)
- `command` + `args`: override default command
- `cwd`: ACP working directory (relative to repo root)
- `env`: environment variables passed only to ACP child process

Switch executor via env:

```bash
export BATON_EXECUTOR=codex
```

Store secrets in env:

```bash
export BATON_FEISHU_APP_ID=cli_xxx
export BATON_FEISHU_APP_SECRET=xxx
export BATON_TELEGRAM_BOT_TOKEN=123456:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export BATON_WHATSAPP_ACCESS_TOKEN=EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export BATON_WHATSAPP_PHONE_NUMBER_ID=123456789012345
export BATON_WHATSAPP_VERIFY_TOKEN=whatsapp-verify-token
export BATON_WHATSAPP_API_BASE=https://graph.facebook.com/v20.0
export BATON_WHATSAPP_PORT=8082
export BATON_WHATSAPP_WEBHOOK_PATH=/webhook/whatsapp
export BATON_SLACK_BOT_TOKEN=xoxb-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export BATON_SLACK_SIGNING_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export BATON_SLACK_API_BASE=https://slack.com/api
export BATON_SLACK_PORT=8081
export BATON_SLACK_WEBHOOK_PATH=/webhook/slack
```

### 2. Start

```bash
# Feishu mode
baton feishu

# Telegram mode
baton telegram

# WhatsApp mode
baton whatsapp

# Slack mode
baton slack

# CLI mode
baton cli

# Set language
baton --mode cli --lang zh-CN
```

## Commands

| Command | Usage | Description |
| --- | --- | --- |
| `/repo` | `/repo` | List repos and open selection |
| `/repo [index/name]` | `/repo 2` or `/repo my-repo` | Switch to target repo |
| `/current` | `/current` | Show session, queue, task status |
| `/stop` | `/stop` | Stop current task |
| `/stop [id]` | `/stop 3` | Stop specific task |
| `/stop all` | `/stop all` | Stop current task and clear queue |
| `/reset` | `/reset` | Reset current session |
| `/new` | `/new` | Alias of `/reset` |
| `/mode` | `/mode` | Open mode selection |
| `/mode [name]` | `/mode code` | Switch Agent Mode directly |
| `/model` | `/model` | Open model selection |
| `/model [name]` | `/model gpt-5` | Switch model directly |
| `/help` | `/help` | Show help |
| Any text | `fix this bug` | Forward prompt to ACP agent |

### Notes

- Any slash command not in the list is forwarded as a normal prompt.
- For selections or permissions, prefer numeric replies (`1`, `2`, ...).
- Text replies also work: `allow` / `deny` / `cancel` / `yes` / `no` / `y` / `n`, or the option name.

## License

Apache 2.0 © Baton Contributors
