# Baton

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue)](https://www.typescriptlang.org/)

Intelligent agent bridge that connects IM channels with local ACP agents.

[中文 README](README.zh-CN.md)

## Installation

### Recommended path

For a first-time setup, the least confusing path is:

1. Install Baton
2. Confirm the `baton` command works
3. Install one ACP runtime
4. Create a minimal config file, then start with Feishu

### 1. Install Baton

```bash
curl -fsSL https://raw.githubusercontent.com/williamfzc/baton/main/install.sh | bash
```

The install script automatically:

- detects your OS and architecture
- downloads the latest release
- installs to `XDG_BIN_HOME` if set, otherwise `~/.local/bin`

No `sudo` required.

### 2. Confirm the install path

After installation, run:

```bash
baton --help
```

If the command is not found, your install directory is probably not in PATH yet. Add this to your shell config such as `~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 3. Install an ACP runtime

Baton is the bridge. You still need an ACP runtime to execute tasks.

Supported options:

- `opencode`: default runtime via `opencode acp`
- `codex`: uses `codex-acp`
- `claude-code`: uses `claude-code-acp`

If you already have `opencode` installed, you can usually keep the default executor. Otherwise, switch the executor in the config file.

Official repositories:

- Codex ACP: https://github.com/zed-industries/codex-acp
- Claude Code ACP: https://github.com/zed-industries/claude-code-acp

Verify commands:

```bash
opencode acp --help
codex-acp --help
claude-code-acp --help
```

### 4. Create the config file

The recommended place is your project root as `baton.config.json`.

By default, Baton looks for these file names from the current directory upward for up to 5 levels:

- `baton.config.json`
- `.batonrc.json`
- `baton.json`

If you prefer another location, you can pass it explicitly:

```bash
baton --config /absolute/path/to/baton.config.json feishu
```

For a first run, this minimal config is enough, with Feishu as the default channel:

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
  "acp": {
    "executor": "opencode"
  }
}
```

The four values you usually need to replace are:

- `project.path`: absolute path to your local project
- `project.name`: display name shown inside Baton
- `feishu.appId`: your Feishu app ID
- `feishu.appSecret`: your Feishu app secret

If you do not want to store secrets in the file, use environment variables instead:

```bash
export BATON_FEISHU_APP_ID=cli_xxx
export BATON_FEISHU_APP_SECRET=xxx
export BATON_EXECUTOR=opencode
```

### 5. Start with Feishu

```bash
baton feishu
```

If your config already contains `feishu.appId` and `feishu.appSecret`, you can also run:

```bash
baton
```

In that case, Baton auto-detects Feishu mode.

If you only want to verify the local agent chain first, start with CLI mode:

```bash
baton cli
```

### Other installation methods

Download from [Releases](https://github.com/williamfzc/baton/releases):

- `baton-linux-x64`
- `baton-darwin-x64` (Intel)
- `baton-darwin-arm64` (Apple Silicon)

```bash
chmod +x baton-*
mkdir -p ~/.local/bin
mv baton-* ~/.local/bin/baton
```

### Run from source

```bash
git clone https://github.com/williamfzc/baton.git
cd baton
bun install
bun run start:cli
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

## Quick Start

### 1. Full config reference

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
