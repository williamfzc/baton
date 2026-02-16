const server = {
  configMissingFeishu: 'Error: Feishu configuration is required',
  configCreateHintFeishu: 'Please create baton.config.json with feishu settings',
  configMissingTelegram: 'Error: Telegram configuration is required',
  configCreateHintTelegram: 'Please create baton.config.json with telegram settings',
  configMissingWhatsApp: 'Error: WhatsApp configuration is required',
  configCreateHintWhatsApp: 'Please create baton.config.json with whatsapp settings',
  configMissingSlack: 'Error: Slack configuration is required',
  configCreateHintSlack: 'Please create baton.config.json with slack settings',
  configMissingDiscord: 'Error: Discord configuration is required',
  configCreateHintDiscord: 'Please create baton.config.json with discord settings',
  configExampleHint: 'See baton.config.example.json for reference',
  scanRootLabel: '📂 Scan directory: ',
  scanRepoFailed: 'Failed to scan repositories',
  noRepoFound: '⚠️ No Git repositories found, using current directory as working directory',
  currentRepoLabel: '📂 Current repo: ',
  multiRepoTitlePrefix: '📦 Found ',
  multiRepoTitleSuffix: ' Git repositories',
  shutdownReceivedPrefix: 'Received ',
  shutdownReceivedSuffix: ', shutting down gracefully...',
  gracefulShutdownSuccess: '✅ Gracefully shut down',
  shutdownError: 'Error during shutdown',
  failedStart: 'Failed to start server',
  bannerFeishu:
    '╔════════════════════════════════════════╗\n║        Baton Feishu Server             ║\n║        (WebSocket Long Connection)     ║\n╚════════════════════════════════════════╝',
  bannerTelegram:
    '╔════════════════════════════════════════╗\n║        Baton Telegram Server           ║\n╚════════════════════════════════════════╝',
  bannerWhatsApp:
    '╔════════════════════════════════════════╗\n║        Baton WhatsApp Server           ║\n╚════════════════════════════════════════╝',
  bannerSlack:
    '╔════════════════════════════════════════╗\n║        Baton Slack Server              ║\n╚════════════════════════════════════════╝',
  bannerDiscord:
    '╔════════════════════════════════════════╗\n║        Baton Discord Server             ║\n╚════════════════════════════════════════╝',
  projectLabel: 'Project: ',
  appIdLabel: 'App ID: ',
  domainLabel: 'Domain: ',
  domainDefault: 'feishu',
  connectingFeishu: 'Connecting to Feishu via WebSocket...',
  connectingTelegram: 'Connecting to Telegram Bot API...',
  connectedSuccess: '✅ Connected successfully!',
  pressCtrlC: 'Press Ctrl+C to exit',
  webhookLabel: 'Webhook: ',
  waitingWhatsApp: 'Waiting for WhatsApp webhook...',
  waitingSlack: 'Waiting for Slack webhook...',
  waitingDiscord: 'Waiting for Discord webhook...',
};

export default server;
