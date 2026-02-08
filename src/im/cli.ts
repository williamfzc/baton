import readline from 'node:readline/promises';
import type { IMMessage, IMResponse, Session } from '../types';
import { CommandDispatcher } from '../core/dispatcher';
import { SessionManager } from '../core/session';
import { TaskQueueEngine } from '../core/queue';
import { BaseIMAdapter, IMPlatform, type IMMessageFormat, type IMReplyOptions } from './adapter';

export class CLIAdapter extends BaseIMAdapter {
  readonly platform = IMPlatform.CLI;

  private projectPath: string;
  private dispatcher: CommandDispatcher;
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;
  private rl: readline.Interface | null = null;
  // 存储正在等待的任务
  private pendingResponses: Map<string, (response: IMResponse) => void> = new Map();

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;

    // 创建会话管理器
    this.sessionManager = new SessionManager(projectPath);

    // 创建任务队列引擎
    this.queueEngine = new TaskQueueEngine(this.onTaskComplete.bind(this));

    // 创建指令分发器
    this.dispatcher = new CommandDispatcher(this.sessionManager, this.queueEngine);
  }

  async start(): Promise<void> {
    console.log('╔════════════════════════════════════════╗');
    console.log('║           Baton CLI v0.1.0             ║');
    console.log('║     ChatOps for Local Development      ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`\nProject: ${this.projectPath}\n`);
    console.log('Type your message (or command), or "quit" to exit:\n');

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await this.runLoop();
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.rl) return;

    const mockUserId = 'local-user';
    const mockUserName = 'Developer';

    while (true) {
      const text = (await this.rl.question('> ')).trim();

      if (text.toLowerCase() === 'quit' || text.toLowerCase() === 'exit') {
        console.log('\n👋 Goodbye!');
        await this.stop();
        process.exit(0);
      }

      if (!text) continue;

      const message: IMMessage = {
        userId: mockUserId,
        userName: mockUserName,
        text,
        timestamp: Date.now(),
      };

      try {
        const response = await this.dispatcher.dispatch(message);

        // 显示初始响应
        await this.displayResponse(response);

        // 如果是 prompt，等待异步任务完成
        if (!text.startsWith('/') || text === '/help' || text === '/current') {
          // 创建 Promise 等待任务完成
          await this.waitForTaskCompletion(mockUserId);
        }
      } catch (error) {
        console.error('❌ Error:', error);
      }
    }
  }

  private async waitForTaskCompletion(userId: string): Promise<void> {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(userId);
        resolve();
      }, 120000); // 2分钟超时

      this.pendingResponses.set(userId, (response: IMResponse) => {
        clearTimeout(timeout);
        this.pendingResponses.delete(userId);
        this.displayResponse(response, true).then(() => resolve());
      });
    });
  }

  private async displayResponse(
    response: IMResponse,
    isAgentResponse: boolean = false
  ): Promise<void> {
    const prefix = isAgentResponse ? '🤖 Agent:' : '📨 Response:';

    console.log('─'.repeat(50));
    console.log(prefix);
    console.log(response.message);
    if (response.data) {
      console.log('\n📊 Data:', JSON.stringify(response.data, null, 2));
    }
    console.log('─'.repeat(50));
    console.log();
  }

  // 实现 IMAdapter 接口

  async sendMessage(
    chatId: string,
    message: IMMessageFormat,
    _options?: IMReplyOptions
  ): Promise<string> {
    // CLI 直接输出到控制台
    const text = message.text || message.markdown || '';
    if (text) {
      console.log(text);
    }
    if (message.code) {
      console.log(`\n\`\`\`${message.code.language}`);
      console.log(message.code.content);
      console.log('```\n');
    }
    return 'cli-msg-' + Date.now();
  }

  async sendReply(chatId: string, messageId: string | undefined, message: IMMessageFormat): Promise<string> {
    // CLI 中 reply 和 sendMessage 相同
    return await this.sendMessage(chatId, message);
  }

  async onTaskComplete(session: Session, response: IMResponse): Promise<void> {
    // 检查是否有等待的 Promise
    const resolver = this.pendingResponses.get(session.userId);
    if (resolver) {
      resolver(response);
    } else {
      // 如果没有等待的 Promise，直接显示
      await this.displayResponse(response, true);
    }
  }

  formatMessage(response: IMResponse): IMMessageFormat {
    return {
      text: response.message,
    };
  }
}
