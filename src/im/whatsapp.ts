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

const logger = createLogger('WhatsAppAdapter');

interface WhatsAppMessageText {
  body?: string;
}

interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp?: string;
  type?: string;
  text?: WhatsAppMessageText;
}

interface WhatsAppContactProfile {
  name?: string;
}

interface WhatsAppContact {
  wa_id?: string;
  profile?: WhatsAppContactProfile;
}

interface WhatsAppChangeValue {
  messaging_product?: string;
  metadata?: {
    phone_number_id?: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
}

interface WhatsAppChange {
  value?: WhatsAppChangeValue;
}

interface WhatsAppEntry {
  changes?: WhatsAppChange[];
}

interface WhatsAppWebhookBody {
  object?: string;
  entry?: WhatsAppEntry[];
}

interface WhatsAppApiResponse {
  messages?: Array<{ id?: string }>;
}

interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  request: RequestPermissionRequest;
}

export class WhatsAppAdapter extends BaseIMAdapter {
  readonly platform = IMPlatform.WHATSAPP;

  private config: BatonConfig;
  private apiBase: string;
  private accessToken: string;
  private phoneNumberId: string;
  private dispatcher: CommandDispatcher;
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;
  private messageContext: Map<string, { chatId: string; messageId: string }> = new Map();
  private processedMessages: Map<string, number> = new Map();
  private messageTTL = 300000;

  constructor(config: BatonConfig, selectedRepo: RepoInfo, repoManager: RepoManager) {
    super();
    this.config = config;

    if (!config.whatsapp?.accessToken || !config.whatsapp?.phoneNumberId) {
      throw new Error('WhatsApp access token and phone number id are required');
    }

    this.accessToken = config.whatsapp.accessToken;
    this.phoneNumberId = config.whatsapp.phoneNumberId;
    this.apiBase = config.whatsapp.apiBase || 'https://graph.facebook.com/v20.0';

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
      config.whatsapp.permissionTimeout,
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

  async handleWebhook(body: unknown): Promise<void> {
    const payload = body as WhatsAppWebhookBody;
    if (!payload.entry || payload.entry.length === 0) return;

    for (const entry of payload.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value;
        if (!value?.messages || value.messages.length === 0) continue;
        const contacts = value.contacts || [];
        for (const message of value.messages) {
          await this.handleIncomingMessage(message, contacts);
        }
      }
    }
  }

  async sendMessage(
    chatId: string,
    message: IMMessageFormat,
    _options?: IMReplyOptions
  ): Promise<string> {
    return this.sendWhatsAppMessage(chatId, undefined, message);
  }

  async sendReply(
    chatId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    return this.sendWhatsAppMessage(chatId, messageId, message);
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

    const newMessageId = await this.sendWhatsAppText(context.chatId, context.messageId, text);
    this.updateSessionMessageContext(session.id, context.chatId, newMessageId);
  }

  formatMessage(response: IMResponse): IMMessageFormat {
    return { text: response.message };
  }

  private async handleIncomingMessage(
    message: WhatsAppMessage,
    contacts: WhatsAppContact[]
  ): Promise<void> {
    if (!message.from) return;
    const text = (message.text?.body || '').trim();
    if (!text) return;

    if (this.isDuplicateMessage(message.id)) {
      return;
    }

    const contact = contacts.find(c => c.wa_id === message.from);
    const userName = contact?.profile?.name || 'Unknown';
    const userId = message.from;
    const contextId = message.from;

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

    this.updateSessionMessageContext(session.id, userId, message.id);

    let response: IMResponse;
    const pendingInteraction = this.getPendingInteraction(session.id, text);
    if (pendingInteraction) {
      response = await this.sessionManager.resolveInteraction(
        session.id,
        pendingInteraction.requestId,
        pendingInteraction.optionId
      );
    } else {
      response = await this.dispatcher.dispatch(imMessage);
    }

    await this.replyWithResponse(userId, message.id, session.id, response);
  }

  private isDuplicateMessage(messageId: string): boolean {
    const now = Date.now();
    const previousTimestamp = this.processedMessages.get(messageId);
    if (previousTimestamp && now - previousTimestamp < this.messageTTL) {
      return true;
    }
    this.processedMessages.set(messageId, now);
    this.cleanupProcessedMessages(now);
    return false;
  }

  private cleanupProcessedMessages(currentTime: number): void {
    for (const [messageId, timestamp] of this.processedMessages.entries()) {
      if (currentTime - timestamp >= this.messageTTL) {
        this.processedMessages.delete(messageId);
      }
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
      const newMessageId = await this.sendWhatsAppText(chatId, messageId, text);
      this.updateSessionMessageContext(sessionId, chatId, newMessageId);
      return;
    }

    if (response.message) {
      const newMessageId = await this.sendWhatsAppText(chatId, messageId, response.message);
      this.updateSessionMessageContext(sessionId, chatId, newMessageId);
    }
  }

  private async handlePermissionRequest(event: PermissionRequestEvent): Promise<void> {
    const { sessionId, request } = event;
    const toolCall = request.toolCall;
    const toolName = toolCall.title || 'Unknown Action';
    const options = request.options;
    const context = this.messageContext.get(sessionId);

    if (!context) {
      logger.warn({ sessionId }, 'No message context found for permission request');
      return;
    }

    const session = this.sessionManager.getSessionById(sessionId);
    const repoPath = session?.repoName || session?.projectPath || 'unknown';

    const text =
      `🔐 ${repoPath}\n\n` +
      `**${String(toolName)}**\n\n` +
      `请回复序号选择操作：\n\n` +
      options.map((opt, idx) => `${idx + 1}. ${opt.name}`).join('\n');

    const newMessageId = await this.sendWhatsAppText(context.chatId, context.messageId, text);
    this.updateSessionMessageContext(sessionId, context.chatId, newMessageId);
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
    const newMessageId = await this.sendWhatsAppText(context.chatId, context.messageId, text);
    this.updateSessionMessageContext(sessionId, context.chatId, newMessageId);
  }

  private getPendingInteraction(
    sessionId: string,
    text: string
  ): { requestId: string; optionId: string } | null {
    const session = this.sessionManager.getSessionById(sessionId);
    if (!session || session.pendingInteractions.size === 0) {
      return null;
    }

    const trimmed = text.trim();
    for (const [requestId, interaction] of session.pendingInteractions) {
      const index = parseInt(trimmed, 10);
      if (!isNaN(index)) {
        const arrayIndex = index - 1;
        if (arrayIndex >= 0 && arrayIndex < interaction.data.options.length) {
          return { requestId, optionId: interaction.data.options[arrayIndex].optionId };
        }
      }

      const option = interaction.data.options.find(
        o => o.name.toLowerCase() === trimmed.toLowerCase()
      );
      if (option) {
        return { requestId, optionId: option.optionId };
      }
    }

    return null;
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
        lines.push(
          element.fields.map(field => `${field.title}: ${field.content}`).join('\n')
        );
      } else if (element.type === 'hr') {
        lines.push('─'.repeat(16));
      } else if (element.type === 'picker') {
        lines.push(element.options.map(opt => opt.name).join('\n'));
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  private async sendWhatsAppMessage(
    chatId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    const text = this.renderMessageText(message);
    return this.sendWhatsAppText(chatId, messageId, text);
  }

  private async sendWhatsAppText(
    chatId: string,
    messageId: string | undefined,
    text: string
  ): Promise<string> {
    try {
      const payload: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to: chatId,
        text: {
          body: text || ' ',
        },
      };

      if (messageId) {
        payload.context = { message_id: messageId };
      }

      const response = await fetch(`${this.apiBase}/${this.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ chatId, status: response.status, errorText }, 'Failed to send WhatsApp');
        return '';
      }

      const json = (await response.json()) as WhatsAppApiResponse;
      return json.messages?.[0]?.id || '';
    } catch (error) {
      logger.error({ error, chatId }, 'Failed to send WhatsApp');
      return '';
    }
  }

  private updateSessionMessageContext(sessionId: string, chatId: string, messageId: string): void {
    if (!messageId) return;
    this.messageContext.set(sessionId, { chatId, messageId });
  }
}
