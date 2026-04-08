const cli = {
  banner:
    '╔════════════════════════════════════════╗\n║           Baton CLI v0.2.2             ║\n╚════════════════════════════════════════╝',
  adapterBanner:
    '╔════════════════════════════════════════╗\n║           Baton CLI v0.2.2             ║\n║     ChatOps for Local Development      ║\n╚════════════════════════════════════════╝',
  rootLabel: '根目录: ',
  projectLabel: '项目: ',
  inputHint: '请输入消息（或指令），输入“quit”退出：\n',
  repoNone: '⚠️  未发现任何 Git 仓库，使用当前目录',
  repoCurrentLabel: '📂 当前仓库: ',
  repoMultipleTitle: '📦 发现多个 Git 仓库:',
  permissionTitle: '权限确认',
  actionLabel: '操作：',
  detailsLabel: '细节：',
  choosePrompt: '请选择：',
  replyRangePrefix: '回复数字 0..',
  replyRangeSuffix: ' 选择。',
  newInstructionHint:
    '如果你想改需求/发送新指令，直接输入内容即可（会自动取消本次权限确认并按新任务处理）。',
  stopHint: '停止任务请发送 /stop。',
  requestIdLabel: '🆔 请求 ID: ',
  agentReplyLabel: '🤖 Agent 回复:',
  agentPrefix: '🤖 Agent:',
  responseLabel: '📨 回复:',
  dataLabel: '📊 数据:',
  goodbye: '👋 再见！',
  errorPrefix: '❌ 错误:',
};

export default cli;
