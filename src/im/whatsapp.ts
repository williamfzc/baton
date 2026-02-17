import type { BatonConfig } from '../config/types';
import type { IMMessage, IMResponse, RepoInfo, Session } from '../types';
import { spawn } from 'node:child_process';
import { CommandDispatcher } from '../core/dispatcher';
import { SessionManager } from '../core/session';
import { TaskQueueEngine } from '../core/queue';
import type { RepoManager } from '../core/repo';
import { createLogger } from '../utils/logger';
import { BaseIMAdapter, IMPlatform, type IMMessageFormat, type IMReplyOptions } from './adapter';
import type { UniversalCard } from './types';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { t } from '../i18n';

const logger = createLogger('WhatsAppAdapter');

interface WacliMessage {
  ChatJID: string;
  ChatName: string;
  MsgID: string;
  SenderJID: string;
  Timestamp: string;
  FromMe: boolean;
  Text: string;
  DisplayText: string;
  MediaType: string;
  Snippet: string;
}

interface WacliMessagesListResponse {
  messages?: WacliMessage[];
  fts?: boolean;
}

interface WacliStdResponse<T = unknown> {
  success?: boolean;
  data?: T;
  error?: unknown;
}

interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  request: RequestPermissionRequest;
}

export class WhatsAppWacliAdapter extends BaseIMAdapter {
  readonly platform = IMPlatform.WHATSAPP;

  private config: BatonConfig;
  private dispatcher: CommandDispatcher;
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;

  private wacliBin: string;
  private wacliStoreDir?: string;
  private pollIntervalMs: number;
  private syncIdleExitMs: number;
  private listLimit: number;
  private includeNonText: boolean;

  private running = false;
  private pollPromise: Promise<void> | null = null;

  // Serialize all wacli invocations to avoid store lock contention.
  // `wacli sync` and `wacli send` will take an exclusive lock; `onTaskComplete`
  // may run concurrently with polling, so we must enforce ordering.
  private wacliSerial: Promise<void> = Promise.resolve();

  private cursorTime: Date;
  private processedKeys: Map<string, number> = new Map();
  private processedTTL = 5 * 60_000;
  private lastCleanup = 0;
  private cleanupInterval = 60_000;

  private messageContext: Map<string, { chatId: string }> = new Map();

  constructor(config: BatonConfig, selectedRepo: RepoInfo, repoManager: RepoManager) {
    super();
    this.config = config;

    const wacli = config.whatsapp?.wacli;
    this.wacliBin = wacli?.bin || 'wacli';
    this.wacliStoreDir = wacli?.storeDir;
    this.pollIntervalMs = wacli?.pollIntervalMs ?? 2000;
    this.syncIdleExitMs = wacli?.syncIdleExitMs ?? 1500;
    this.listLimit = wacli?.listLimit ?? 50;
    this.includeNonText = wacli?.includeNonText ?? false;

    this.cursorTime = this.parseInitialAfter(wacli?.initialAfter) || new Date();

    const executor = (config.acp?.executor || process.env.BATON_EXECUTOR || 'opencode').replace(
      /_/g,
      '-'
    );
    const acpLaunchConfig = config.acp?.command
      ? {
          command: config.acp.command,
          args: config.acp.args,
          cwd: config.acp.cwd,
          env: config.acp.env,
        }
      : undefined;

    this.sessionManager = new SessionManager(
      config.whatsapp?.permissionTimeout,
      executor,
      acpLaunchConfig
    );
    this.sessionManager.setRepoManager(repoManager);
    this.sessionManager.setCurrentRepo(selectedRepo);

    this.sessionManager.on('permissionRequest', async event => {
      await this.handlePermissionRequest(event as PermissionRequestEvent);
    });

    this.sessionManager.on(
      'selectionPrompt',
      async (event: { sessionId: string; requestId: string; response: IMResponse }) => {
        await this.handleSelectionPrompt(event);
      }
    );

    this.queueEngine = new TaskQueueEngine(this.onTaskComplete.bind(this));
    this.dispatcher = new CommandDispatcher(this.sessionManager, this.queueEngine);
  }

  async start(): Promise<void> {
    // 快速探测 wacli 是否可用（避免 silent failure）
    const check = await this.runWacli(['version'], 10_000);
    if (check.exitCode !== 0) {
      logger.error(
        { stderr: check.stderr, stdout: check.stdout },
        'wacli not available or failed to run'
      );
      throw new Error('wacli not available');
    }

    // 认证状态检查：未登录时直接失败，避免一直空轮询
    const auth = await this.runWacli(['auth', 'status'], 10_000);
    if (auth.exitCode !== 0) {
      logger.error({ stderr: auth.stderr, stdout: auth.stdout }, 'wacli auth status failed');
      throw new Error('wacli auth status failed');
    }

    try {
      const parsed = JSON.parse(auth.stdout || '{}') as WacliStdResponse<{
        authenticated?: boolean;
      }>;
      if (!parsed.data?.authenticated) {
        throw new Error('not authenticated');
      }
    } catch (error) {
      logger.error(
        { error, stdout: auth.stdout },
        'wacli not authenticated; run `wacli auth` first'
      );
      throw new Error('wacli not authenticated; run `wacli auth` first');
    }

    this.running = true;
    this.pollPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.pollPromise;
    } finally {
      this.pollPromise = null;
    }

    // Ensure all queued wacli commands are drained before shutdown.
    await this.wacliSerial;
  }

  async sendMessage(
    chatId: string,
    message: IMMessageFormat,
    _options?: IMReplyOptions
  ): Promise<string> {
    const text = this.renderMessageText(message);
    await this.sendWacliText(chatId, text);
    return '';
  }

  async sendReply(
    chatId: string,
    _messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    // wacli send 不支持按 messageId 引用回复，这里退化为直接发送
    return this.sendMessage(chatId, message);
  }

  async onTaskComplete(session: Session, response: IMResponse): Promise<void> {
    const context = this.messageContext.get(session.id);
    if (!context) {
      logger.error('No chat context found for session');
      return;
    }

    const repoPath = session.repoName || session.projectPath || 'unknown';
    const text = this.renderCardToText({
      title: `${response.success ? '✅' : '❌'} ${repoPath}`,
      elements: [
        { type: 'markdown', content: response.message },
        { type: 'hr' },
        { type: 'markdown', content: `🆔 ${session.id}` },
      ],
    });
    await this.sendWacliText(context.chatId, text);
  }

  formatMessage(response: IMResponse): IMMessageFormat {
    return { text: response.message };
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.syncOnce();
        await this.consumeNewMessages();
      } catch (error) {
        logger.error({ error }, 'wacli polling loop error');
      }

      await this.sleep(this.pollIntervalMs);
    }
  }

  private async syncOnce(): Promise<void> {
    const idleExit = `${Math.max(200, this.syncIdleExitMs)}ms`;
    const res = await this.runWacli(['sync', '--once', '--idle-exit', idleExit], 120_000);
    if (res.exitCode !== 0) {
      logger.warn({ stderr: res.stderr, stdout: res.stdout }, 'wacli sync failed');
    }
  }

  private async consumeNewMessages(): Promise<void> {
    // wacli 的 DB ts 精度为秒，做一个安全回看窗口避免漏消息
    const safetyWindowMs = 2_000;
    const after = new Date(this.cursorTime.getTime() - safetyWindowMs);
    const messages = await this.listMessages(after);

    // messages list 默认按时间倒序返回，这里翻转成时间正序处理
    const ordered = [...messages].reverse();

    let maxTs = this.cursorTime;
    for (const m of ordered) {
      const msgTime = new Date(m.Timestamp);
      if (Number.isNaN(msgTime.getTime())) continue;

      // 跳过自己发出的消息，避免回环
      if (m.FromMe) continue;

      const key = `${m.ChatJID}:${m.MsgID}`;
      if (this.isDuplicate(key)) continue;

      const text = this.pickMessageText(m);
      if (!text) continue;

      const userId = m.SenderJID || m.ChatJID;
      const userName = m.SenderJID || m.ChatJID;
      const contextId = m.ChatJID;

      const imMessage: IMMessage = {
        userId,
        userName,
        text,
        timestamp: msgTime.getTime(),
        contextId,
      };

      const projectPath =
        this.sessionManager.resolveProjectPath(imMessage.userId, imMessage.contextId) ||
        this.config.project?.path ||
        '';
      const session = await this.sessionManager.getOrCreateSession(
        imMessage.userId,
        imMessage.contextId,
        projectPath
      );

      this.messageContext.set(session.id, { chatId: m.ChatJID });

      const interactionResponse = await this.sessionManager.tryResolveInteraction(session.id, text);
      const response: IMResponse =
        interactionResponse || (await this.dispatcher.dispatch(imMessage));

      await this.replyWithResponse(m.ChatJID, session.id, response);

      if (msgTime.getTime() > maxTs.getTime()) {
        maxTs = msgTime;
      }
    }

    // cursorTime 前进
    this.cursorTime = maxTs;
  }

  private pickMessageText(m: WacliMessage): string {
    const text = (m.DisplayText || m.Text || '').trim();
    if (text) return text;
    if (this.includeNonText && (m.MediaType || '').trim()) {
      return `[media] ${m.MediaType}`;
    }
    return '';
  }

  private async replyWithResponse(
    chatId: string,
    sessionId: string,
    response: IMResponse
  ): Promise<void> {
    if (response.card) {
      const text = this.renderCardToText(response.card);
      await this.sendWacliText(chatId, text);
      return;
    }

    if (response.message) {
      await this.sendWacliText(chatId, response.message);
      // wacli 模式没有可更新的 messageId，这里仅保留 chatId
      this.messageContext.set(sessionId, { chatId });
    }
  }

  private async handlePermissionRequest(event: PermissionRequestEvent): Promise<void> {
    const { sessionId, request } = event;
    const toolCall = request.toolCall;
    const toolName = toolCall.title || t('im', 'unknownAction');
    const options = request.options;
    const context = this.messageContext.get(sessionId);

    if (!context) {
      logger.warn({ sessionId }, 'No chat context found for permission request');
      return;
    }

    const session = this.sessionManager.getSessionById(sessionId);
    const repoPath = session?.repoName || session?.projectPath || t('im', 'unknownRepo');

    const text =
      `🔐 ${repoPath}\n\n` +
      `**${String(toolName)}**\n\n` +
      `${t('im', 'selectByNumber')}\n\n` +
      options.map((opt, idx) => `${idx + 1}. ${opt.name}`).join('\n');

    await this.sendWacliText(context.chatId, text);
  }

  private async handleSelectionPrompt(event: {
    sessionId: string;
    requestId: string;
    response: IMResponse;
  }): Promise<void> {
    const { sessionId, response } = event;
    const context = this.messageContext.get(sessionId);
    if (!context) return;

    const text = response.card ? this.renderCardToText(response.card) : response.message || '';
    await this.sendWacliText(context.chatId, text);
  }

  private async listMessages(after: Date): Promise<WacliMessage[]> {
    const res = await this.runWacli(
      [
        'messages',
        'list',
        '--limit',
        String(this.listLimit),
        '--after',
        this.formatWacliTime(after),
      ],
      20_000
    );

    if (res.exitCode !== 0) {
      logger.warn({ stderr: res.stderr, stdout: res.stdout }, 'wacli messages list failed');
      return [];
    }

    try {
      const parsed = JSON.parse(res.stdout || '{}') as WacliMessagesListResponse;
      return parsed.messages || [];
    } catch (error) {
      logger.warn({ error, stdout: res.stdout }, 'Failed to parse wacli messages list JSON');
      return [];
    }
  }

  private async sendWacliText(chatId: string, text: string): Promise<void> {
    const msg = (text || ' ').trimEnd();
    const res = await this.runWacli(['send', 'text', '--to', chatId, '--message', msg], 30_000);
    if (res.exitCode !== 0) {
      logger.error({ chatId, stderr: res.stderr, stdout: res.stdout }, 'Failed to send via wacli');
    }
  }

  private runWacli(
    args: string[],
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return this.enqueueWacli(() => this.runWacliRaw(args, timeoutMs));
  }

  private enqueueWacli<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.wacliSerial.then(fn, fn);
    // Keep the chain alive regardless of success/failure.
    this.wacliSerial = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private runWacliRaw(
    args: string[],
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const cmd = [this.wacliBin];
    if (this.wacliStoreDir) {
      cmd.push('--store', this.wacliStoreDir);
    }
    cmd.push('--json', ...args);

    return new Promise(resolve => {
      const child = spawn(cmd[0], cmd.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

      const timer = setTimeout(
        () => {
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
        },
        Math.max(1000, timeoutMs)
      );

      child.on('close', code => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      });

      child.on('error', err => {
        clearTimeout(timer);
        resolve({ stdout, stderr: `${stderr}\n${String(err)}`.trim(), exitCode: 1 });
      });
    });
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    const previous = this.processedKeys.get(key);
    if (previous && now - previous < this.processedTTL) {
      return true;
    }

    this.processedKeys.set(key, now);

    if (now - this.lastCleanup > this.cleanupInterval) {
      for (const [k, ts] of this.processedKeys.entries()) {
        if (now - ts >= this.processedTTL) {
          this.processedKeys.delete(k);
        }
      }
      this.lastCleanup = now;
    }

    return false;
  }

  private parseInitialAfter(raw?: string): Date | null {
    const v = (raw || '').trim();
    if (!v) return null;
    const ts = Date.parse(v);
    if (Number.isNaN(ts)) return null;
    return new Date(ts);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * wacli 的 `--after/--before` 使用 Go 的 `time.RFC3339` 解析，
   * 不接受 Date#toISOString() 默认带的毫秒（.123Z）。
   */
  private formatWacliTime(d: Date): string {
    const iso = d.toISOString();
    return iso.replace(/\.\d{3}Z$/, 'Z');
  }

  private renderMessageText(message: IMMessageFormat): string {
    if (message.card) {
      return this.renderCardToText(message.card);
    }
    const base = message.text || message.markdown || '';
    if (message.code) {
      return `${base}\n\n\`\`\`\n${message.code.content}\n\`\`\``.trim();
    }
    return base;
  }

  private renderCardToText(card: UniversalCard): string {
    const lines: string[] = [];
    if (card.title) {
      lines.push(card.title);
    }
    for (const element of card.elements) {
      if (element.type === 'markdown' || element.type === 'text') {
        lines.push(element.content);
      } else if (element.type === 'field_group') {
        lines.push(element.fields.map(field => `${field.title}: ${field.content}`).join('\n'));
      } else if (element.type === 'hr') {
        lines.push('─'.repeat(16));
      } else if (element.type === 'picker') {
        lines.push(element.options.map(opt => opt.name).join('\n'));
      }
    }
    return lines.filter(Boolean).join('\n');
  }
}
