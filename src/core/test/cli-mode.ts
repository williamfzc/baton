/**
 * LocalCLIMode - 本地终端测试模式
 *
 * 提供一个交互式的命令行界面，用于测试 FakeACPClient
 */
import * as readline from 'node:readline';
import { FakeACPClient } from './fake-acp';

const COMMANDS = `
╔══════════════════════════════════════════════════════════════╗
║              Baton FakeACP 本地测试模式                       ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  📝 基本使用                                                  ║
║     直接输入文本 → 发送给 FakeACP                            ║
║     /help → 显示此帮助                                        ║
║                                                              ║
║  🧪 测试功能                                                  ║
║     /set <text>    → 设置响应文本                            ║
║     /delay <ms>    → 设置响应延迟                            ║
║     /permit on/off → 启用/禁用权限请求                        ║
║     /modes         → 列出可用模式                            ║
║     /models        → 列出可用模型                            ║
║     /mode <name>   → 切换模式                               ║
║     /model <name>  → 切换模型                               ║
║     /clear         → 清屏                                    ║
║     /exit          → 退出                                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`;

interface FakeACPState {
  response: string;
  delay: number;
  triggerPermission: boolean;
}

export class LocalCLIMode {
  private client: FakeACPClient;
  private rl: readline.Interface;
  private fakeState: FakeACPState;

  constructor() {
    this.client = new FakeACPClient();
    this.fakeState = {
      response: '[FakeACP] 这是一个模拟的 Agent 响应',
      delay: 0,
      triggerPermission: false,
    };

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: ' baton> ',
    });

    process.on('SIGINT', () => {
      console.log('\n👋 退出测试模式');
      this.rl.close();
      process.exit(0);
    });
  }

  async start(): Promise<void> {
    await this.client.startAgent();

    console.clear();
    console.log(COMMANDS);
    console.log('🚀 FakeACP 测试模式已启动\n');

    this.rl.prompt();

    this.rl.on('line', async line => {
      const trimmed = line.trim();

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('👋 再见！');
        await this.client.stop();
        this.rl.close();
        process.exit(0);
      }

      try {
        await this.handleCommand(trimmed);
      } catch (error) {
        console.error(`❌ 错误: ${error instanceof Error ? error.message : String(error)}`);
      }

      this.rl.prompt();
    });
  }

  private async handleCommand(input: string): Promise<void> {
    const trimmed = input.trim();

    if (trimmed.startsWith('/')) {
      await this.handleSystemCommand(trimmed);
      return;
    }

    // 发送消息
    console.log(`\n📤 发送: "${trimmed}"\n`);

    const response = await this.client.sendPrompt(trimmed);
    this.printResponse(response);
  }

  private async handleSystemCommand(command: string): Promise<void> {
    const parts = command.split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/help':
        console.log(COMMANDS);
        break;

      case '/set':
        if (args.length > 0) {
          this.fakeState.response = args.join(' ');
          this.client.setPromptConfig({ response: this.fakeState.response });
          console.log(`✅ 响应已设置为: "${this.fakeState.response}"`);
        } else {
          console.log(`❌ 用法: /set <text>`);
        }
        break;

      case '/delay':
        const delay = parseInt(args[0] || '0', 10);
        this.fakeState.delay = delay;
        this.client.setPromptConfig({ delay });
        console.log(`✅ 延迟已设置为: ${delay}ms`);
        break;

      case '/permit':
        const enable = args[0] !== 'off';
        this.fakeState.triggerPermission = enable;
        this.client.setPromptConfig({
          triggerPermission: enable
            ? {
                title: '测试权限请求',
                options: [
                  { optionId: 'allow', name: '允许', kind: 'allow_once' },
                  { optionId: 'deny', name: '拒绝', kind: 'allow_once' },
                ],
              }
            : undefined,
        });
        console.log(`✅ 权限请求: ${enable ? '启用' : '禁用'}`);
        break;

      case '/modes':
        const modes = this.client.getModeState();
        console.log(`\n🎨 可用模式: ${modes.availableModes.map(m => m.id).join(', ')}`);
        console.log(`   当前: ${modes.currentModeId}\n`);
        break;

      case '/models':
        const models = this.client.getModelState();
        console.log(`\n🤖 可用模型: ${models.availableModels.map(m => m.modelId).join(', ')}`);
        console.log(`   当前: ${models.currentModelId}\n`);
        break;

      case '/mode':
        if (args.length > 0) {
          const result = await this.client.setMode(args[0]);
          this.printResponse(result);
        } else {
          console.log(`\n🎨 当前模式: ${this.client.getModeState().currentModeId}\n`);
        }
        break;

      case '/model':
        if (args.length > 0) {
          const result = await this.client.setModel(args[0]);
          this.printResponse(result);
        } else {
          console.log(`\n🤖 当前模型: ${this.client.getModelState().currentModelId}\n`);
        }
        break;

      case '/clear':
        console.clear();
        break;

      case '/status':
        console.log(`\n🧪 FakeACP 状态:`);
        console.log(`   响应: ${this.fakeState.response}`);
        console.log(`   延迟: ${this.fakeState.delay}ms`);
        console.log(`   权限请求: ${this.fakeState.triggerPermission ? '是' : '否'}\n`);
        break;

      default:
        console.log(`❌ 未知命令: ${cmd}`);
        console.log('   输入 /help 查看帮助');
    }
  }

  private printResponse(response: { success: boolean; message: string }): void {
    const icon = response.success ? '✅' : '❌';
    console.log(`${icon} ${response.message}\n`);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  const cli = new LocalCLIMode();
  cli.start().catch(console.error);
}
