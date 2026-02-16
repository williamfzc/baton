import type { BatonConfig } from '../config/types';
import type { IMMessage, IMResponse, RepoInfo, Session } from '../types';
import { CommandDispatcher } from '../core/dispatcher';
import { SessionManager } from '../core/session';
import { TaskQueueEngine } from '../core/queue';
import type { RepoManager } from '../core/repo';
import { createLogger } from '../utils/logger';
import { BaseIMAdapter, IMPlatform, type IMMessageFormat, type IMReplyOptions } from './adapter';
import type { UniversalCard } from './types';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { t } from '../i18n';

const logger = createLogger('TelegramAdapter');

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  date: number;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  request: RequestPermissionRequest;
}

export class TelegramAdapter extends BaseIMAdapter {
  readonly platform = IMPlatform.TELEGRAM;

  private config: BatonConfig;
  private apiBase: string;
  private dispatcher: CommandDispatcher;
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;
  private polling = false;
  private pollPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private lastUpdateId = 0;
  private messageContext: Map<string, { chatId: string; messageId: string }> = new Map();
  private requestSessionMap: Map<string, string> = new Map();

  constructor(config: BatonConfig, selectedRepo: RepoInfo, repoManager: RepoManager) {
    super();
    this.config = config;

    if (!config.telegram?.botToken) {
      throw new Error('Telegram bot token is required');
    }

    this.apiBase =
      config.telegram.apiBase || `https://api.telegram.org/bot${config.telegram.botToken}`;

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
      config.telegram.permissionTimeout,
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
    if (this.polling) return;
    this.polling = true;
    this.abortController = new AbortController();
    this.pollPromise = this.pollUpdates();
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.pollPromise) {
      await this.pollPromise;
    }
  }

  async sendMessage(
    chatId: string,
    message: IMMessageFormat,
    _options?: IMReplyOptions
  ): Promise<string> {
    return this.sendTelegramMessage(chatId, undefined, message);
  }

  async sendReply(
    chatId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    return this.sendTelegramMessage(chatId, messageId, message);
  }

  async onTaskComplete(session: Session, response: IMResponse): Promise<void> {
    const context = this.messageContext.get(session.id);
    if (!context) {
      logger.error('No message context found for session');
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

    const newMessageId = await this.sendTelegramText(context.chatId, context.messageId, text);
    this.updateSessionMessageContext(session.id, context.chatId, newMessageId);
  }

  formatMessage(response: IMResponse): IMMessageFormat {
    return { text: response.message };
  }

  private async pollUpdates(): Promise<void> {
    while (this.polling) {
      try {
        const response = await this.apiRequest<TelegramUpdate[]>('getUpdates', {
          offset: this.lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        });

        if (response?.ok && response.result && response.result.length > 0) {
          for (const update of response.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            await this.handleUpdate(update);
          }
        }
      } catch (error) {
        logger.error({ error }, 'Polling updates failed');
        await this.delay(1000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const text = (message.text || '').trim();
    if (!text) return;

    const user = message.from;
    const userId = user ? String(user.id) : 'unknown';
    const userName =
      user?.username || [user?.first_name, user?.last_name].filter(Boolean).join(' ');

    const imMessage: IMMessage = {
      userId,
      userName: userName || 'Unknown',
      text,
      timestamp: Date.now(),
      contextId: chatId,
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

    this.updateSessionMessageContext(session.id, chatId, String(message.message_id));

    const interactionResponse = await this.sessionManager.tryResolveInteraction(session.id, text);
    const response: IMResponse = interactionResponse || (await this.dispatcher.dispatch(imMessage));

    await this.replyWithResponse(chatId, String(message.message_id), session.id, response);
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const data = query.data || '';
    if (!data.startsWith('resolve|')) {
      await this.answerCallbackQuery(query.id, '已忽略');
      return;
    }

    const parts = data.split('|');
    const requestId = parts[1];
    const optionId = parts.slice(2).join('|');
    const sessionId = this.requestSessionMap.get(requestId);

    if (!sessionId) {
      await this.answerCallbackQuery(query.id, '请求已过期');
      return;
    }

    const result = await this.sessionManager.resolveInteraction(sessionId, requestId, optionId);
    await this.answerCallbackQuery(query.id, result.message);

    const chatId = query.message ? String(query.message.chat.id) : undefined;
    const messageId = query.message ? String(query.message.message_id) : undefined;
    if (chatId) {
      await this.replyWithResponse(chatId, messageId, sessionId, result);
    }
  }

  private async replyWithResponse(
    chatId: string,
    messageId: string | undefined,
    sessionId: string,
    response: IMResponse
  ): Promise<void> {
    if (response.card) {
      const text = this.renderCardToText(response.card);
      const newMessageId = await this.sendTelegramText(chatId, messageId, text);
      this.updateSessionMessageContext(sessionId, chatId, newMessageId);
      return;
    }

    if (response.message) {
      const newMessageId = await this.sendTelegramText(chatId, messageId, response.message);
      this.updateSessionMessageContext(sessionId, chatId, newMessageId);
    }
  }

  private async handlePermissionRequest(event: PermissionRequestEvent): Promise<void> {
    const { sessionId, requestId, request } = event;
    const toolCall = request.toolCall;
    const toolName = toolCall.title || t('im', 'unknownAction');
    const options = request.options;
    const context = this.messageContext.get(sessionId);

    if (!context) {
      logger.warn({ sessionId }, 'No message context found for permission request');
      return;
    }

    const session = this.sessionManager.getSessionById(sessionId);
    const repoPath = session?.repoName || session?.projectPath || t('im', 'unknownRepo');

    const text =
      `🔐 ${repoPath}\n\n` +
      `**${String(toolName)}**\n\n` +
      `${t('im', 'selectByButton')}\n\n` +
      options.map((opt, idx) => `${idx + 1}. ${opt.name}`).join('\n');

    const keyboard = this.buildKeyboard(requestId, options);
    const newMessageId = await this.sendTelegramText(context.chatId, context.messageId, text, {
      inline_keyboard: keyboard,
    });
    this.updateSessionMessageContext(sessionId, context.chatId, newMessageId);
    this.requestSessionMap.set(requestId, sessionId);
  }

  private async handleSelectionPrompt(event: {
    sessionId: string;
    requestId: string;
    response: IMResponse;
  }): Promise<void> {
    const { sessionId, requestId, response } = event;
    const context = this.messageContext.get(sessionId);
    if (!context) return;

    const session = this.sessionManager.getSessionById(sessionId);
    const interaction = session?.pendingInteractions.get(requestId);
    if (!interaction) return;

    const text = response.card ? this.renderCardToText(response.card) : response.message || '';
    const keyboard = this.buildKeyboard(requestId, interaction.data.options);
    const newMessageId = await this.sendTelegramText(context.chatId, context.messageId, text, {
      inline_keyboard: keyboard,
    });
    this.updateSessionMessageContext(sessionId, context.chatId, newMessageId);
    this.requestSessionMap.set(requestId, sessionId);
  }

  private buildKeyboard(
    requestId: string,
    options: Array<{ optionId: string; name: string }>
  ): Array<Array<{ text: string; callback_data: string }>> {
    return options.map(option => [
      {
        text: option.name,
        callback_data: `resolve|${requestId}|${option.optionId}`,
      },
    ]);
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

  private async sendTelegramMessage(
    chatId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    const text = this.renderMessageText(message);
    return this.sendTelegramText(chatId, messageId, text);
  }

  private async sendTelegramText(
    chatId: string,
    messageId: string | undefined,
    text: string,
    replyMarkup?: Record<string, unknown>
  ): Promise<string> {
    try {
      const response = await this.apiRequest<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text: text || ' ',
        reply_to_message_id: messageId ? Number(messageId) : undefined,
        reply_markup: replyMarkup,
      });

      if (!response.ok) {
        logger.error({ chatId, response }, 'Failed to send Telegram message');
        return '';
      }
      return response.result?.message_id ? String(response.result.message_id) : '';
    } catch (error) {
      logger.error({ error, chatId }, 'Failed to send Telegram message');
      return '';
    }
  }

  private async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    try {
      await this.apiRequest('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: text || '已处理',
        show_alert: false,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to answer callback query');
    }
  }

  private async apiRequest<T>(
    method: string,
    body: Record<string, unknown>
  ): Promise<TelegramApiResponse<T>> {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController?.signal,
    });

    const json = (await response.json()) as TelegramApiResponse<T>;
    if (!json.ok) {
      logger.error({ method, json }, 'Telegram API error');
    }
    return json;
  }

  private updateSessionMessageContext(sessionId: string, chatId: string, messageId: string): void {
    if (!messageId) return;
    this.messageContext.set(sessionId, { chatId, messageId });
  }

  private async delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}
