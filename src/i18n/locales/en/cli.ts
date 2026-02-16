const cli = {
  banner:
    '╔════════════════════════════════════════╗\n║           Baton CLI v0.1.0             ║\n╚════════════════════════════════════════╝',
  adapterBanner:
    '╔════════════════════════════════════════╗\n║           Baton CLI v0.1.0             ║\n║     ChatOps for Local Development      ║\n╚════════════════════════════════════════╝',
  rootLabel: 'Root: ',
  projectLabel: 'Project: ',
  inputHint: 'Type your message (or command), or "quit" to exit:\n',
  repoNone: '⚠️  No Git repositories found, using current directory',
  repoCurrentLabel: '📂 Current repo: ',
  repoMultipleTitle: '📦 Multiple Git repositories found:',
  permissionTitle: 'Permission Confirmation',
  actionLabel: 'Action: ',
  detailsLabel: 'Details:',
  choosePrompt: 'Please choose:',
  replyRangePrefix: 'Reply with a number 0..',
  replyRangeSuffix: ' to choose.',
  newInstructionHint:
    'If you want to change the requirement or send a new instruction, just input it directly (this will cancel the current permission request and start the new task).',
  stopHint: 'To stop the task, send /stop.',
  requestIdLabel: '🆔 Request ID: ',
  agentReplyLabel: '🤖 Agent Reply:',
  agentPrefix: '🤖 Agent:',
  responseLabel: '📨 Response:',
  dataLabel: '📊 Data:',
  goodbye: '👋 Goodbye!',
  errorPrefix: '❌ Error:',
};

export default cli;
