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

const logger = createLogger('DiscordAdapter');

interface DiscordUser {
  id?: string;
  username?: string;
  global_name?: string;
}

interface DiscordMember {
  user?: DiscordUser;
  nick?: string;
}

interface DiscordInteractionOption {
  name?: string;
  value?: string | number | boolean;
}

interface DiscordInteractionData {
  name?: string;
  options?: DiscordInteractionOption[];
  custom_id?: string;
  values?: string[];
}

interface DiscordInteraction {
  id?: string;
  type?: number;
  token?: string;
  application_id?: string;
  channel_id?: string;
  guild_id?: string;
  data?: DiscordInteractionData;
  member?: DiscordMember;
  user?: DiscordUser;
}

interface DiscordMessageResponse {
  id?: string;
}

interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  request: RequestPermissionRequest;
}

export class DiscordAdapter extends BaseIMAdapter {
  readonly platform = IMPlatform.DISCORD;

  private config: BatonConfig;
  private botToken: string;
  private apiBase: string;
  private dispatcher: CommandDispatcher;
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;
  private messageContext: Map<
    string,
    { channelId: string; interactionToken?: string; applicationId?: string; messageId?: string }
  > = new Map();
  private processedInteractions: Map<string, number> = new Map();
  private interactionTTL = 300000;
  private lastCleanup = 0;
  private cleanupInterval = 60000;

  constructor(config: BatonConfig, selectedRepo: RepoInfo, repoManager: RepoManager) {
    super();
    this.config = config;

    if (!config.discord?.botToken) {
      throw new Error('Discord bot token is required');
    }

    this.botToken = config.discord.botToken;
    this.apiBase = config.discord.apiBase || 'https://discord.com/api/v10';

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
      config.discord.permissionTimeout,
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

  async handleWebhook(payload: DiscordInteraction): Promise<void> {
    if (!payload.id || !payload.channel_id) return;
    if (payload.type === 1) return;
    if (this.isDuplicateInteraction(payload.id)) return;

    const text = this.extractText(payload);
    if (!text) return;

    const user = payload.member?.user || payload.user;
    const userId = user?.id;
    if (!userId) return;

    const userName = payload.member?.nick || user?.global_name || user?.username || userId;
    const channelId = payload.channel_id;
    const contextId = channelId;

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

    this.updateSessionMessageContext(session.id, {
      channelId,
      interactionToken: payload.token,
      applicationId: payload.application_id,
    });

    const interactionResponse = await this.sessionManager.tryResolveInteraction(session.id, text);
    const response: IMResponse = interactionResponse || (await this.dispatcher.dispatch(imMessage));

    await this.replyWithResponse(channelId, session.id, response);
  }

  async sendMessage(
    chatId: string,
    message: IMMessageFormat,
    options?: IMReplyOptions
  ): Promise<string> {
    return this.sendDiscordMessage(chatId, options?.replyToMessageId, message);
  }

  async sendReply(
    chatId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    return this.sendDiscordMessage(chatId, messageId, message);
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

    const newMessageId = await this.sendDiscordResponse(session.id, context.channelId, text);
    this.updateSessionMessageContext(session.id, {
      ...context,
      messageId: newMessageId || context.messageId,
    });
  }

  formatMessage(response: IMResponse): IMMessageFormat {
    return { text: response.message };
  }

  private async replyWithResponse(
    channelId: string,
    sessionId: string,
    response: IMResponse
  ): Promise<void> {
    if (response.card) {
      const text = this.renderCardToText(response.card);
      const newMessageId = await this.sendDiscordResponse(sessionId, channelId, text);
      this.updateSessionMessageContext(sessionId, { channelId, messageId: newMessageId });
      return;
    }

    if (response.message) {
      const newMessageId = await this.sendDiscordResponse(sessionId, channelId, response.message);
      this.updateSessionMessageContext(sessionId, { channelId, messageId: newMessageId });
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
      `**${String(toolName)}**\n\n` +
      `${t('im', 'selectByNumber')}\n\n` +
      options.map((opt, idx) => `${idx + 1}. ${opt.name}`).join('\n');

    const newMessageId = await this.sendDiscordResponse(sessionId, context.channelId, text);
    this.updateSessionMessageContext(sessionId, { ...context, messageId: newMessageId });
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
    const newMessageId = await this.sendDiscordResponse(sessionId, context.channelId, text);
    this.updateSessionMessageContext(sessionId, { ...context, messageId: newMessageId });
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

  private extractText(payload: DiscordInteraction): string {
    const data = payload.data;
    if (!data) return '';

    if (data.values && data.values.length > 0) {
      return String(data.values[0]).trim();
    }

    if (data.options && data.options.length > 0) {
      const values = data.options
        .map(option => option.value)
        .filter(value => value !== undefined && value !== null)
        .map(value => String(value));
      if (values.length > 0) {
        return values.join(' ').trim();
      }
    }

    if (data.custom_id) {
      return data.custom_id.trim();
    }

    return (data.name || '').trim();
  }

  private async sendDiscordMessage(
    channelId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    const text = this.renderMessageText(message);
    return this.sendDiscordText(channelId, messageId, text);
  }

  private async sendDiscordResponse(
    sessionId: string,
    channelId: string,
    text: string
  ): Promise<string> {
    const context = this.messageContext.get(sessionId);
    if (context?.interactionToken && context.applicationId) {
      return this.sendDiscordFollowup(context.applicationId, context.interactionToken, text);
    }
    return this.sendDiscordText(channelId, undefined, text);
  }

  private async sendDiscordText(
    channelId: string,
    messageId: string | undefined,
    text: string
  ): Promise<string> {
    try {
      const payload: Record<string, unknown> = {
        content: text || ' ',
      };
      if (messageId) {
        payload.message_reference = {
          message_id: messageId,
          channel_id: channelId,
        };
      }

      const response = await fetch(`${this.apiBase}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bot ${this.botToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { channelId, status: response.status, errorText },
          'Failed to send Discord message'
        );
        return '';
      }

      const json = (await response.json()) as DiscordMessageResponse;
      return json.id || '';
    } catch (error) {
      logger.error({ error, channelId }, 'Failed to send Discord message');
      return '';
    }
  }

  private async sendDiscordFollowup(
    applicationId: string,
    interactionToken: string,
    text: string
  ): Promise<string> {
    try {
      const response = await fetch(
        `${this.apiBase}/webhooks/${applicationId}/${interactionToken}?wait=true`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ content: text || ' ' }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, errorText }, 'Failed to send Discord followup');
        return '';
      }

      const json = (await response.json()) as DiscordMessageResponse;
      return json.id || '';
    } catch (error) {
      logger.error({ error }, 'Failed to send Discord followup');
      return '';
    }
  }

  private updateSessionMessageContext(
    sessionId: string,
    context: {
      channelId: string;
      interactionToken?: string;
      applicationId?: string;
      messageId?: string;
    }
  ): void {
    this.messageContext.set(sessionId, context);
  }

  private isDuplicateInteraction(interactionId: string): boolean {
    const now = Date.now();
    const previousTimestamp = this.processedInteractions.get(interactionId);
    if (previousTimestamp && now - previousTimestamp < this.interactionTTL) {
      return true;
    }
    this.processedInteractions.set(interactionId, now);
    if (now - this.lastCleanup > this.cleanupInterval) {
      this.cleanupProcessedInteractions(now);
      this.lastCleanup = now;
    }
    return false;
  }

  private cleanupProcessedInteractions(currentTime: number): void {
    for (const [interactionId, timestamp] of this.processedInteractions.entries()) {
      if (currentTime - timestamp >= this.interactionTTL) {
        this.processedInteractions.delete(interactionId);
      }
    }
  }
}
