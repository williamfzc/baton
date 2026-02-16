const main = {
  helpText: `
Usage:
  baton [mode] [workdir]
  baton --mode <auto|cli|feishu|telegram|whatsapp|slack|discord> [--dir <path>]
  baton -m <auto|cli|feishu|telegram|whatsapp|slack|discord> [-C <path>]

Modes:
  auto      Auto select based on config (default)
  cli       Force CLI interactive mode
  feishu    Force Feishu mode
  telegram  Force Telegram mode
  whatsapp  Force WhatsApp mode
  slack     Force Slack mode
  discord   Force Discord mode

Options:
  -h, --help              Show help
  -m, --mode <mode>       Set run mode
  -d, --dir <path>        Set working directory (same as -C)
  -C <path>               Set working directory
  -c, --config <path>     Set config file path (feishu/telegram/auto only)
  -l, --lang <lang>       Set language (en | zh-CN)

Examples:
  baton
  baton cli
  baton feishu /path/to/workspace
  baton telegram /path/to/workspace
  baton whatsapp /path/to/workspace
  baton slack /path/to/workspace
  baton discord /path/to/workspace
  baton --mode cli --dir /path/to/workspace
  baton --mode auto --config ./baton.config.json
`.trim(),
  invalidModePrefix: 'Invalid mode: ',
  invalidModeSuffix: ', available: auto | cli | feishu | telegram | whatsapp | slack | discord',
  emptyValue: '(empty)',
  missingPathArgSuffix: ' requires a path argument',
  missingFileArgSuffix: ' requires a file path argument',
  missingLangArgSuffix: ' requires a language argument',
  unknownArgPrefix: 'Unknown argument: ',
  detectFeishu: '🤖 Feishu configuration detected, starting Feishu mode...',
  detectTelegram: '🤖 Telegram configuration detected, starting Telegram mode...',
  detectWhatsApp: '🤖 WhatsApp configuration detected, starting WhatsApp mode...',
  detectSlack: '🤖 Slack configuration detected, starting Slack mode...',
  detectDiscord: '🤖 Discord configuration detected, starting Discord mode...',
  detectCliFallback: '💻 No Feishu configuration detected, starting CLI mode...',
  forceCliHint: '   (Use bun run start -- cli to force CLI mode)',
  forceImHint: '   (Use bun run start -- feishu/telegram/whatsapp/slack/discord to force IM mode)',
};

export default main;
