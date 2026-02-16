const server = {
  configMissingFeishu: '错误：需要 Feishu 配置',
  configCreateHintFeishu: '请创建带有 feishu 配置的 baton.config.json',
  configMissingTelegram: '错误：需要 Telegram 配置',
  configCreateHintTelegram: '请创建带有 telegram 配置的 baton.config.json',
  configMissingWhatsApp: '错误：需要 WhatsApp 配置',
  configCreateHintWhatsApp: '请创建带有 whatsapp 配置的 baton.config.json',
  configMissingSlack: '错误：需要 Slack 配置',
  configCreateHintSlack: '请创建带有 slack 配置的 baton.config.json',
  configMissingDiscord: '错误：需要 Discord 配置',
  configCreateHintDiscord: '请创建带有 discord 配置的 baton.config.json',
  configExampleHint: '可参考 baton.config.example.json',
  scanRootLabel: '📂 扫描目录: ',
  scanRepoFailed: '扫描仓库失败',
  noRepoFound: '⚠️ 未发现任何 Git 仓库，使用当前目录作为工作目录',
  currentRepoLabel: '📂 当前仓库: ',
  multiRepoTitlePrefix: '📦 发现 ',
  multiRepoTitleSuffix: ' 个 Git 仓库',
  shutdownReceivedPrefix: '收到信号 ',
  shutdownReceivedSuffix: '，正在优雅退出...',
  gracefulShutdownSuccess: '✅ 已优雅退出',
  shutdownError: '退出过程中发生错误',
  failedStart: '启动服务失败',
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
  projectLabel: '项目: ',
  appIdLabel: '应用 ID: ',
  domainLabel: '域名: ',
  domainDefault: 'feishu',
  connectingFeishu: '正在通过 WebSocket 连接 Feishu...',
  connectingTelegram: '正在连接 Telegram Bot API...',
  connectedSuccess: '✅ 连接成功！',
  pressCtrlC: '按 Ctrl+C 退出',
  webhookLabel: 'Webhook: ',
  waitingWhatsApp: '等待 WhatsApp webhook...',
  waitingSlack: '等待 Slack webhook...',
  waitingDiscord: '等待 Discord webhook...',
};

export default server;
