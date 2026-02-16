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

const logger = createLogger('SlackAdapter');

interface SlackEventEnvelope {
  type?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackEvent;
}

interface SlackEvent {
  type?: string;
  user?: string;
  text?: string;
  ts?: string;
  channel?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  user_profile?: {
    display_name?: string;
    real_name?: string;
    name?: string;
  };
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
}

interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  request: RequestPermissionRequest;
}

export class SlackAdapter extends BaseIMAdapter {
  readonly platform = IMPlatform.SLACK;

  private config: BatonConfig;
  private botToken: string;
  private apiBase: string;
  private dispatcher: CommandDispatcher;
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;
  private messageContext: Map<string, { channelId: string; messageId: string }> = new Map();
  private processedEvents: Map<string, number> = new Map();
  private eventTTL = 300000;
  private lastCleanup = 0;
  private cleanupInterval = 60000;

  constructor(config: BatonConfig, selectedRepo: RepoInfo, repoManager: RepoManager) {
    super();
    this.config = config;

    if (!config.slack?.botToken) {
      throw new Error('Slack bot token is required');
    }

    this.botToken = config.slack.botToken;
    this.apiBase = config.slack.apiBase || 'https://slack.com/api';

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
      config.slack.permissionTimeout,
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

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async handleWebhook(payload: SlackEventEnvelope): Promise<void> {
    if (payload.type !== 'event_callback' || !payload.event) return;
    if (payload.event_id && this.isDuplicateEvent(payload.event_id)) return;
    await this.handleEvent(payload.event);
  }

  async sendMessage(
    chatId: string,
    message: IMMessageFormat,
    options?: IMReplyOptions
  ): Promise<string> {
    return this.sendSlackMessage(chatId, options?.replyToMessageId, message);
  }

  async sendReply(
    chatId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    return this.sendSlackMessage(chatId, messageId, message);
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

    const newMessageId = await this.sendSlackText(context.channelId, context.messageId, text);
    this.updateSessionMessageContext(session.id, context.channelId, newMessageId);
  }

  formatMessage(response: IMResponse): IMMessageFormat {
    return { text: response.message };
  }

  private async handleEvent(event: SlackEvent): Promise<void> {
    try {
      if (!event.channel || !event.ts) return;
      if (event.subtype === 'bot_message' || event.bot_id) return;
      if (!event.user) return;

      const text = this.normalizeText(event.text || '');
      if (!text) return;

      const userId = event.user;
      const userName =
        event.user_profile?.display_name ||
        event.user_profile?.real_name ||
        event.user_profile?.name ||
        userId;
      const channelId = event.channel;
      const threadId = event.thread_ts || event.ts;
      const contextId = event.thread_ts ? `${channelId}:${event.thread_ts}` : channelId;

      const imMessage: IMMessage = {
        userId,
        userName,
        text,
        timestamp: Date.now(),
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

      this.updateSessionMessageContext(session.id, channelId, threadId);

      const interactionResponse = await this.sessionManager.tryResolveInteraction(session.id, text);
      const response: IMResponse =
        interactionResponse || (await this.dispatcher.dispatch(imMessage));

      await this.replyWithResponse(channelId, threadId, session.id, response);
    } catch (error) {
      logger.error({ error }, 'Error handling Slack event');
    }
  }

  private isDuplicateEvent(eventId: string): boolean {
    const now = Date.now();
    const previousTimestamp = this.processedEvents.get(eventId);
    if (previousTimestamp && now - previousTimestamp < this.eventTTL) {
      return true;
    }
    this.processedEvents.set(eventId, now);
    if (now - this.lastCleanup > this.cleanupInterval) {
      this.cleanupProcessedEvents(now);
      this.lastCleanup = now;
    }
    return false;
  }

  private cleanupProcessedEvents(currentTime: number): void {
    for (const [eventId, timestamp] of this.processedEvents.entries()) {
      if (currentTime - timestamp >= this.eventTTL) {
        this.processedEvents.delete(eventId);
      }
    }
  }

  private async replyWithResponse(
    channelId: string,
    messageId: string | undefined,
    sessionId: string,
    response: IMResponse
  ): Promise<void> {
    if (response.card) {
      const text = this.renderCardToText(response.card);
      const newMessageId = await this.sendSlackText(channelId, messageId, text);
      this.updateSessionMessageContext(sessionId, channelId, newMessageId);
      return;
    }

    if (response.message) {
      const newMessageId = await this.sendSlackText(channelId, messageId, response.message);
      this.updateSessionMessageContext(sessionId, channelId, newMessageId);
    }
  }

  private async handlePermissionRequest(event: PermissionRequestEvent): Promise<void> {
    const { sessionId, request } = event;
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
      `*${String(toolName)}*\n\n` +
      `${t('im', 'selectByNumber')}\n\n` +
      options.map((opt, idx) => `${idx + 1}. ${opt.name}`).join('\n');

    const newMessageId = await this.sendSlackText(context.channelId, context.messageId, text);
    this.updateSessionMessageContext(sessionId, context.channelId, newMessageId);
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
    const newMessageId = await this.sendSlackText(context.channelId, context.messageId, text);
    this.updateSessionMessageContext(sessionId, context.channelId, newMessageId);
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

  private async sendSlackMessage(
    channelId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    const text = this.renderMessageText(message);
    return this.sendSlackText(channelId, messageId, text);
  }

  private async sendSlackText(
    channelId: string,
    messageId: string | undefined,
    text: string
  ): Promise<string> {
    try {
      const payload: Record<string, unknown> = {
        channel: channelId,
        text: text || ' ',
      };
      if (messageId) {
        payload.thread_ts = messageId;
      }

      const response = await fetch(`${this.apiBase}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.botToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { channelId, status: response.status, errorText },
          'Failed to send Slack message'
        );
        return '';
      }

      const json = (await response.json()) as SlackApiResponse;
      if (!json.ok) {
        logger.error({ channelId, error: json.error }, 'Slack API error');
        return '';
      }
      return json.ts || '';
    } catch (error) {
      logger.error({ error, channelId }, 'Failed to send Slack message');
      return '';
    }
  }

  private updateSessionMessageContext(
    sessionId: string,
    channelId: string,
    messageId: string
  ): void {
    if (!messageId) return;
    this.messageContext.set(sessionId, { channelId, messageId });
  }

  private normalizeText(text: string): string {
    return text.replace(/^<@[^>]+>\s*/, '').trim();
  }
}
