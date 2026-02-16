/**
 * CLI 适配器
 * 命令行交互适配器，处理本地命令行模式下的消息收发
 * 提供基于 readline 的交互式界面
 */
import readline from 'node:readline/promises';
import * as path from 'node:path';
import type { IMMessage, IMResponse, Session } from '../types';
import { CommandDispatcher } from '../core/dispatcher';
import { SessionManager } from '../core/session';
import { TaskQueueEngine } from '../core/queue';
import { BaseIMAdapter, IMPlatform, type IMMessageFormat, type IMReplyOptions } from './adapter';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';

const logger = createLogger('CLIAdapter');

export class CLIAdapter extends BaseIMAdapter {
  readonly platform = IMPlatform.CLI;

  private projectPath: string;
  private dispatcher: CommandDispatcher;
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;
  private rl: readline.Interface | null = null;
  // 存储正在等待的任务
  private pendingResponses: Map<string, (response: IMResponse) => void> = new Map();
  // 用于防止重复处理（如用户快速按回车）
  private lastInput: { text: string; timestamp: number } | null = null;
  private duplicateTTL: number = 1000; // 1秒内相同内容视为重复

  constructor(projectPath: string) {
    super();
    this.projectPath = projectPath;

    // 创建会话管理器
    this.sessionManager = new SessionManager();
    this.sessionManager.setCurrentRepo({
      name: path.basename(this.projectPath),
      path: this.projectPath,
      gitPath: path.join(this.projectPath, '.git'),
    });

    // 创建任务队列引擎
    this.queueEngine = new TaskQueueEngine(this.onTaskComplete.bind(this));

    // 创建指令分发器
    this.dispatcher = new CommandDispatcher(this.sessionManager, this.queueEngine);
  }

  async start(): Promise<void> {
    console.log(t('cli', 'adapterBanner'));
    console.log(`\n${t('cli', 'projectLabel')}${this.projectPath}\n`);
    console.log(t('cli', 'inputHint'));

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
        console.log(`\n${t('cli', 'goodbye')}`);
        await this.stop();
        process.exit(0);
      }

      if (!text) continue;

      // 去重检查：防止用户快速重复输入
      const now = Date.now();
      if (
        this.lastInput &&
        this.lastInput.text === text &&
        now - this.lastInput.timestamp < this.duplicateTTL
      ) {
        logger.debug({ text }, 'Skipping duplicate input');
        continue;
      }
      this.lastInput = { text, timestamp: now };

      const message: IMMessage = {
        userId: mockUserId,
        userName: mockUserName,
        text,
        timestamp: now,
        contextId: 'cli',
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
        console.error(t('cli', 'errorPrefix'), error);
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
    const prefix = isAgentResponse ? t('cli', 'agentPrefix') : t('cli', 'responseLabel');

    console.log('─'.repeat(50));
    console.log(prefix);
    console.log(response.message);
    if (response.data) {
      console.log(`\n${t('cli', 'dataLabel')}`, JSON.stringify(response.data, null, 2));
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

  async sendReply(
    chatId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
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
