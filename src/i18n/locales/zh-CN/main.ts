const main = {
  helpText: `
Usage:
  baton [mode] [workdir]
  baton --mode <auto|cli|feishu|telegram|whatsapp|slack|discord> [--dir <path>]
  baton -m <auto|cli|feishu|telegram|whatsapp|slack|discord> [-C <path>]

Modes:
  auto      根据配置自动选择（默认）
  cli       强制启动命令行交互模式
  feishu    强制启动飞书模式
  telegram  强制启动 Telegram 模式
  whatsapp  强制启动 WhatsApp 模式
  slack     强制启动 Slack 模式
  discord   强制启动 Discord 模式

Options:
  -h, --help              显示帮助
  -m, --mode <mode>       指定启动模式
  -d, --dir <path>        指定工作目录（等价于 -C）
  -C <path>               指定工作目录
  -c, --config <path>     指定配置文件路径（仅 feishu/telegram/auto 模式使用）
  -l, --lang <lang>       指定语言（en | zh-CN）

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
  invalidModePrefix: '无效 mode: ',
  invalidModeSuffix: '，可选: auto | cli | feishu | telegram | whatsapp | slack | discord',
  emptyValue: '(empty)',
  missingPathArgSuffix: ' 需要一个路径参数',
  missingFileArgSuffix: ' 需要一个文件路径参数',
  missingLangArgSuffix: ' 需要一个语言参数',
  unknownArgPrefix: '未知参数: ',
  detectFeishu: '🤖 检测到飞书配置，启动飞书模式...',
  detectTelegram: '🤖 检测到 Telegram 配置，启动 Telegram 模式...',
  detectWhatsApp: '🤖 检测到 WhatsApp 配置，启动 WhatsApp 模式...',
  detectSlack: '🤖 检测到 Slack 配置，启动 Slack 模式...',
  detectDiscord: '🤖 检测到 Discord 配置，启动 Discord 模式...',
  detectCliFallback: '💻 未检测到飞书配置，启动 CLI 模式...',
  forceCliHint: '   (使用 bun run start -- cli 强制 CLI 模式)',
  forceImHint: '   (使用 bun run start -- feishu/telegram/whatsapp/slack/discord 强制 IM 模式)',
};

export default main;
