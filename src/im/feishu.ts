/**
 * 飞书适配器
 * 实现飞书平台的 WebSocket 长链接通信，处理消息收发和事件订阅
 * 作为 IM 接入层与核心逻辑层的桥梁，将飞书消息转换为 Baton 内部格式
 * 支持多仓库切换
 */
import * as lark from '@larksuiteoapi/node-sdk';
import type { BatonConfig } from '../config/types';
import type { IMMessage, IMResponse, Session, RepoInfo } from '../types';
import { CommandDispatcher } from '../core/dispatcher';
import { SessionManager } from '../core/session';
import { TaskQueueEngine } from '../core/queue';
import { RepoManager } from '../core/repo';
import { createLogger } from '../utils/logger';
import { BaseIMAdapter, IMPlatform, type IMMessageFormat, type IMReplyOptions } from './adapter';
import { convertToFeishuCard } from './feishu/converter';
import type { UniversalCard } from './types';

const logger = createLogger('FeishuAdapter');

// 飞书消息数据结构接口
interface FeishuMessage {
  message_id: string;
  chat_id: string;
  content: string;
  create_time: string;
  message_type?: string;
}

interface FeishuSender {
  sender_id: {
    user_id?: string;
    open_id?: string;
    name?: string;
  };
  sender_type?: string;
}

interface FeishuMessageData {
  message: FeishuMessage;
  sender: FeishuSender;
}

// 事件处理器数据类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface EventData extends Record<string, any> {}

// 权限请求事件类型
interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: any;
}

// 卡片操作数据类型
interface CardActionData {
  action: {
    value: string | Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

// 权限选项类型
interface PermissionOption {
  optionId: string;
  name: string;
}

export class FeishuAdapter extends BaseIMAdapter {
  readonly platform = IMPlatform.FEISHU;

  private config: BatonConfig;
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private eventDispatcher: lark.EventDispatcher;
  private dispatcher: CommandDispatcher;
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;
  // 存储 message_id 用于后续回复
  private messageContext: Map<string, { chatId: string; messageId: string }> = new Map();
  // 存储 sessionContext 用于权限请求反查 userId
  private sessionContext: Map<string, { userId: string }> = new Map();
  // 用于防止重复处理消息
  private processedMessages: Map<string, number> = new Map();
  private messageTTL: number = 300000; // 5分钟内认为是重复消息（防止网络延迟导致的重发）

  constructor(config: BatonConfig, selectedRepo?: RepoInfo, repoManager?: RepoManager) {
    super();
    this.config = config;

    if (!config.feishu) {
      throw new Error('Feishu config is required');
    }

    // 创建飞书客户端
    this.client = new lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: config.feishu.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    });

    // 创建会话管理器
    const projectPath = selectedRepo?.path || config.project.path;
    this.sessionManager = new SessionManager(projectPath, config.feishu.card?.permissionTimeout);

    if (repoManager && selectedRepo) {
      this.sessionManager.setRepoManager(repoManager);
      this.sessionManager.setCurrentRepo(selectedRepo);
    }

    // 监听权限请求事件
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.sessionManager.on('permissionRequest', async event => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await this.handlePermissionRequest(event);
    });

    // 创建任务队列引擎，传入完成回调
    this.queueEngine = new TaskQueueEngine(this.onTaskComplete.bind(this));

    // 创建指令分发器
    this.dispatcher = new CommandDispatcher(this.sessionManager, this.queueEngine);

    // 创建事件分发器
    this.eventDispatcher = new lark.EventDispatcher({});

    // 注册事件处理器
    this.registerEventHandlers();

    // 创建 WebSocket 长链接客户端
    this.wsClient = new lark.WSClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      domain: config.feishu.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    });
  }

  private registerEventHandlers(): void {
    // 注册消息接收事件
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: EventData) => {
        await this.handleMessage(data as unknown as FeishuMessageData);
      },
    });

    // 注册消息已读事件（忽略，避免警告）
    this.eventDispatcher.register({
      'im.message.message_read_v1': async () => {
        // 忽略已读事件
      },
    });

    // 注册卡片交互事件
    this.eventDispatcher.register({
      'card.action.trigger': async (data: EventData) => {
        return await this.handleCardAction(data as unknown as CardActionData);
      },
    });
  }

  // 处理权限请求，发送交互卡片
  private async handlePermissionRequest(event: PermissionRequestEvent): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { sessionId, requestId, request } = event;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const toolCall = request.toolCall;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const toolName = toolCall.title || 'Unknown Action';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const options = request.options as PermissionOption[];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    logger.info({ sessionId, requestId, toolName }, 'Handling permission request');

    // 尝试获取 chatId 和上一次的消息 ID
    const context = this.messageContext.get(sessionId);
    if (!context) {
      logger.warn(
        { sessionId },
        'No message context found for session, cannot send permission card'
      );
      return;
    }

    // 获取 session 信息以获取仓库路径
    const session = this.sessionManager.getSessionById(sessionId);
    const repoPath = session?.repoName || session?.projectPath || 'unknown';

    // 构建卡片内容 - 只保留核心对话内容
    const elements: { type: 'markdown'; content: string }[] = [
      {
        type: 'markdown',
        content: `**${toolName}**`,
      },
      {
        type: 'markdown',
        content: `---\nSession ID: ${sessionId}`,
      },
    ];

    // 构建动态按钮
    const actions = options.map(opt => ({
      id: `permission_${opt.optionId}`,
      text: opt.name,
      style: (opt.name.toLowerCase().includes('allow') || opt.name.toLowerCase().includes('yes')
        ? 'primary'
        : opt.name.toLowerCase().includes('deny') || opt.name.toLowerCase().includes('no')
          ? 'danger'
          : 'default') as 'primary' | 'danger' | 'default',
      value: JSON.stringify({
        action: 'resolve_permission',
        session_id: sessionId,
        request_id: requestId,
        option_id: opt.optionId,
      }),
    }));

    // 构建通用卡片 - 标题包含仓库路径
    const card: UniversalCard = {
      title: `🔐 ${repoPath}`,
      elements,
      actions: actions as unknown as {
        id: string;
        text: string;
        style: 'primary' | 'danger' | 'default';
        value: string;
      }[],
    };

    // 发送卡片作为回复，并更新上下文 ID
    const newMessageId = await this.sendReply(context.chatId, context.messageId, { card });
    this.updateSessionMessageContext(sessionId, context.chatId, newMessageId);
  }

  private updateSessionMessageContext(sessionId: string, chatId: string, messageId: string): void {
    if (!messageId) return;
    this.messageContext.set(sessionId, { chatId, messageId });
  }

  private async handleMessage(data: FeishuMessageData): Promise<void> {
    try {
      // 调试：打印完整数据结构
      logger.debug({ rawData: data }, 'Raw message data');

      const message = data.message;
      const sender = data.sender;

      // 安全检查
      if (!message || !sender) {
        logger.warn({ data }, 'Invalid message data');
        return;
      }

      // 检查是否为重复消息
      if (message.message_id) {
        const now = Date.now();
        const previousTimestamp = this.processedMessages.get(message.message_id);

        // 如果消息在 TTL 时间内已经被处理过，则跳过
        if (previousTimestamp && now - previousTimestamp < this.messageTTL) {
          logger.debug({ message_id: message.message_id }, 'Skipping duplicate message');
          return;
        }

        // 记录消息处理时间
        this.processedMessages.set(message.message_id, now);

        // 清理过期的消息记录
        this.cleanupProcessedMessages(now);
      }

      // 调试：打印关键字段
      logger.debug(
        {
          message_id: message.message_id,
          chat_id: message.chat_id,
          content: message.content,
          create_time: message.create_time,
          sender_id: sender.sender_id,
          sender_type: sender.sender_type,
        },
        'Message structure'
      );

      // 提取消息内容
      let text = '';
      try {
        const content = JSON.parse(message.content || '{}') as { text?: string };
        text = (content as { text?: string }).text || '';
      } catch (e) {
        text = message.content || '';
      }

      // 提取用户ID（可能是 user_id 或 open_id）
      const userId = sender.sender_id?.user_id || sender.sender_id?.open_id || 'unknown';
      const userName = sender.sender_id?.name || 'Unknown';

      // 构建 IMMessage，添加 chat_id 作为 contextId 实现群聊隔离
      const imMessage: IMMessage = {
        userId,
        userName,
        text: text.trim(),
        timestamp: Date.now(),
        contextId: message.chat_id,
      };

      logger.info(
        { userName, userId, contextId: message.chat_id, text: text.substring(0, 50) },
        'Received message'
      );

      // 获取或创建会话，传递 contextId 实现群聊隔离
      const session = await this.sessionManager.getOrCreateSession(
        imMessage.userId,
        imMessage.contextId
      );

      // 存储初始消息上下文
      this.updateSessionMessageContext(session.id, message.chat_id, message.message_id);

      // 存储 sessionContext
      this.sessionContext.set(session.id, { userId });

      // 添加 "眼睛" reaction 表示已读（仅在 message_id 存在时）
      if (message.message_id) {
        await this.addReaction(message.chat_id, message.message_id, 'OK').catch(() => {
          // 忽略 reaction 失败
        });
      }

      // 发送到指令分发器
      const response = await this.dispatcher.dispatch(imMessage);

      // 发送初始回复卡片（所有回复都使用卡片格式）
      if (response.message) {
        // 获取仓库路径
        const repoPath = session.repoName || session.projectPath || 'unknown';

        // 构建初始回复卡片
        const initialCard: UniversalCard = {
          title: `💬 ${repoPath}`,
          elements: [
            {
              type: 'markdown',
              content: this.truncateMessage(response.message, 2000),
            },
            {
              type: 'markdown',
              content: `---\nSession ID: ${session.id}`,
            },
          ],
        };

        const newMessageId = await this.sendReply(message.chat_id, message.message_id, {
          card: initialCard,
        });
        this.updateSessionMessageContext(session.id, message.chat_id, newMessageId);
      }
    } catch (error) {
      logger.error(error, 'Error handling message');
    }
  }

  private async handleCardAction(data: CardActionData): Promise<unknown> {
    logger.info({ action: data.action }, 'Card action received');

    try {
      // 飞书卡片按钮的 value 结构是: { action_id: string, value: string }
      // 我们实际的 payload 在 value.value 中
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const actionData = data.action.value as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const actionValue = actionData?.value;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: any;

      // 尝试解析 payload
      if (typeof actionValue === 'object') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload = actionValue;
      } else if (typeof actionValue === 'string') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          payload = JSON.parse(actionValue);
        } catch (e) {
          logger.warn({ actionValue }, 'Failed to parse action value JSON');
          return;
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        logger.warn({ actionData }, 'Invalid action value structure');
        return;
      }

      // 检查是否是权限处理动作
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (payload.action === 'resolve_permission') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const { session_id, request_id, option_id } = payload;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        logger.info(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment
          { session_id, request_id, option_id },
          'Resolving permission from card interaction'
        );

        // 调用 SessionManager 解决权限
        // 注意：resolvePermission 是我们刚加的方法，需要确保 SessionManager 上有这个方法
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const result = this.sessionManager.resolvePermission(session_id, request_id, option_id);

        // 更新卡片或发送通知
        // 飞书允许直接返回新的卡片内容来更新原卡片（Toast）
        // 这里我们可以简单地返回一个 Toast
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
        return {
          toast: {
            type: result.success ? 'success' : 'error',
            content: result.message,
          },
          // 可选：更新原卡片状态，比如把按钮置灰
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      }
    } catch (error) {
      logger.error(error, 'Error handling card action');
    }
  }

  // 实现 IMAdapter 接口方法

  async start(): Promise<void> {
    logger.info('Starting WebSocket client...');
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    logger.info('WebSocket client started');
  }

  async stop(): Promise<void> {
    logger.info('Stopping WebSocket client...');
    this.wsClient.close();
    logger.info('WebSocket client stopped');
  }

  async sendMessage(
    chatId: string,
    message: IMMessageFormat,
    _options?: IMReplyOptions
  ): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const content = this.buildFeishuContent(message);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res = await this.client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        content: JSON.stringify(content),
        msg_type: this.getMessageType(message),
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const newMessageId = res.data?.message_id || '';
    logger.debug(
      { chatId, messageType: this.getMessageType(message), newMessageId },
      'Message sent'
    );
    return newMessageId;
  }

  async sendReply(
    chatId: string,
    messageId: string | undefined,
    message: IMMessageFormat
  ): Promise<string> {
    // 飞书支持引用回复
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const content = this.buildFeishuContent(message);

    interface MessageData {
      receive_id: string;
      content: string;
      msg_type: string;
      reply_message_id?: string;
    }

    const data: MessageData = {
      receive_id: chatId,
      content: JSON.stringify(content),
      msg_type: this.getMessageType(message),
    };

    // 仅在 messageId 存在时添加引用
    if (messageId) {
      data.reply_message_id = messageId;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const res = await this.client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data,
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const newMessageId = res.data?.message_id || '';
    logger.debug({ chatId, hasReply: !!messageId, newMessageId }, 'Reply sent');
    return newMessageId;
  }

  async addReaction(_chatId: string, messageId: string, reaction: string): Promise<void> {
    try {
      // 飞书表情回复 API
      await this.client.im.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: reaction,
          },
        },
      });
      logger.debug({ messageId, reaction }, 'Reaction added');
    } catch (error) {
      // Reaction 失败不影响主流程
      logger.debug({ messageId, reaction, error }, 'Failed to add reaction');
    }
  }

  async onTaskComplete(session: Session, response: IMResponse): Promise<void> {
    const context = this.messageContext.get(session.id);
    if (!context) {
      logger.error('No message context found for session');
      return;
    }

    const { chatId, messageId } = context;

    // 获取仓库路径
    const repoPath = session.repoName || session.projectPath || 'unknown';

    // 构建富文本完成卡片 - 简洁格式
    const completionCard: UniversalCard = {
      title: `${response.success ? '✅' : '❌'} ${repoPath}`,
      elements: [
        {
          type: 'markdown',
          content: this.truncateMessage(response.message, 2000), // 飞书卡片长度限制
        },
        {
          type: 'markdown',
          content: `---\nSession ID: ${session.id}`,
        },
      ],
    };

    // 发送卡片回复，并更新上下文
    const newMessageId = await this.sendReply(chatId, messageId, { card: completionCard });
    this.updateSessionMessageContext(session.id, chatId, newMessageId);

    // 添加完成 reaction (给最后一条消息加)
    if (newMessageId) {
      await this.addReaction(chatId, newMessageId, 'OK').catch(() => {});
    }

    logger.info({ sessionId: session.id, chatId }, 'Task completed and rich card sent');
  }

  private truncateMessage(msg: string, limit: number): string {
    if (msg.length <= limit) return msg;
    return msg.substring(0, limit) + '\n\n...(内容过多已截断)';
  }

  formatMessage(response: IMResponse): IMMessageFormat {
    // 飞书支持 Markdown，可以直接使用
    return {
      text: response.message,
      markdown: response.message,
    };
  }

  // 辅助方法

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildFeishuContent(message: IMMessageFormat): any {
    if (message.card) {
      return convertToFeishuCard(message.card);
    }

    if (message.code) {
      return {
        code: {
          language: message.code.language,
          content: message.code.content,
        },
      };
    }

    if (message.markdown) {
      return {
        text: message.markdown,
      };
    }

    return {
      text: message.text || '',
    };
  }

  private getMessageType(message: IMMessageFormat): string {
    if (message.card) return 'interactive';
    if (message.code) return 'text'; // 代码块作为文本发送
    return 'text';
  }

  // 获取飞书客户端实例（用于高级操作）
  getClient(): lark.Client {
    return this.client;
  }

  // 清理过期的消息记录
  private cleanupProcessedMessages(currentTime: number): void {
    for (const [messageId, timestamp] of this.processedMessages.entries()) {
      if (currentTime - timestamp >= this.messageTTL) {
        this.processedMessages.delete(messageId);
      }
    }
  }
}
