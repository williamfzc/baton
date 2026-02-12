/**
 * TestSessionManager - 可测试的会话管理器
 *
 * 特性：
 * - 独立的内存存储（每个实例）
 * - 使用 FakeACPClient
 * - 快速创建/销毁
 * - 完整的生命周期管理
 */
import type { Session, IMResponse, RepoInfo } from '../../types';
import type { UniversalCard } from '../../im/types';
import { EventEmitter } from 'node:events';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { FakeACPClient, type PermissionHandler } from './fake-acp';

const logger = {
  info: (...args: unknown[]) => console.log('[TestSession]', ...args),
  warn: (...args: unknown[]) => console.warn('[TestSession WARN]', ...args),
  error: (...args: unknown[]) => console.error('[TestSession ERROR]', ...args),
};

// 简单的 UUID 生成函数
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * FakeACPClient 工厂接口
 */
export interface FakeACPClientFactory {
  create(permissionHandler: PermissionHandler): FakeACPClient;
}

/**
 * 默认的 FakeACPClient 工厂
 */
export class DefaultACPClientFactory implements FakeACPClientFactory {
  create(permissionHandler: PermissionHandler): FakeACPClient {
    return new FakeACPClient(permissionHandler);
  }
}

/**
 * TestSessionManager - 可测试的会话管理器
 */
export class TestSessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private repoManager: {
    findRepo(id: string): { name: string; path: string; gitPath: string } | null;
    listRepos(): { name: string; path: string; gitPath: string }[];
  } | null = null;
  private currentRepoInfo: RepoInfo | null = null;
  private acpClientFactory: FakeACPClientFactory;
  private permissionTimeout: number;

  constructor(options?: {
    acpClientFactory?: FakeACPClientFactory;
    permissionTimeoutSeconds?: number;
  }) {
    super();
    this.acpClientFactory = options?.acpClientFactory || new DefaultACPClientFactory();
    this.permissionTimeout = (options?.permissionTimeoutSeconds || 300) * 1000;
  }

  // ============ Repository Management ============

  setRepoManager(repoManager: typeof this.repoManager): void {
    this.repoManager = repoManager;
  }

  setCurrentRepo(repoInfo: RepoInfo): void {
    this.currentRepoInfo = repoInfo;
  }

  getCurrentRepo(): RepoInfo | null {
    return this.currentRepoInfo;
  }

  getRepoManager(): typeof this.repoManager {
    return this.repoManager;
  }

  // ============ Session Lifecycle ============

  private buildSessionKey(
    userId: string,
    contextId: string | undefined,
    projectPath: string
  ): string {
    if (contextId) {
      return `${userId}:${contextId}:${projectPath}`;
    }
    return `${userId}:${projectPath}`;
  }

  async getOrCreateSession(
    userId: string,
    contextId: string | undefined,
    projectPath: string
  ): Promise<Session> {
    const sessionKey = this.buildSessionKey(userId, contextId, projectPath);

    if (!this.sessions.has(sessionKey)) {
      const session: Session = {
        id: generateUUID(),
        userId,
        projectPath,
        repoName: this.currentRepoInfo?.name,
        acpClient: null,
        queue: {
          pending: [],
          current: null,
        },
        isProcessing: false,
        availableModes: [],
        availableModels: [],
        pendingInteractions: new Map(),
      };

      // 定义权限处理函数
      const permissionHandler = async (req: RequestPermissionRequest): Promise<string> => {
        return new Promise<string>(resolve => {
          const requestId = generateUUID();

          session.pendingInteractions.set(requestId, {
            type: 'permission',
            resolve,
            reject: () => {},
            timestamp: Date.now(),
            data: {
              title: req.toolCall.title ?? '权限请求',
              options: req.options.map(o => ({ optionId: o.optionId, name: o.name })),
              originalRequest: req,
            },
          });

          // 触发事件通知
          this.emit('permissionRequest', {
            sessionId: session.id,
            requestId,
            userId: session.userId,
            request: req,
          });

          // 设置超时自动拒绝
          setTimeout(() => {
            if (session.pendingInteractions.has(requestId)) {
              const pending = session.pendingInteractions.get(requestId);
              const fallbackOption =
                req.options.find(o => o.name.toLowerCase().includes('deny'))?.optionId || 'deny';
              pending?.resolve(fallbackOption);
              session.pendingInteractions.delete(requestId);
            }
          }, this.permissionTimeout);
        });
      };

      // 创建 FakeACPClient
      const acpClient = this.acpClientFactory.create(permissionHandler);
      await acpClient.startAgent();
      session.acpClient = acpClient as any; // 类型兼容

      // 同步初始状态
      const modeState = acpClient.getModeState();
      const modelState = acpClient.getModelState();
      session.availableModes = modeState.availableModes;
      session.currentModeId = modeState.currentModeId;
      session.availableModels = modelState.availableModels;
      session.currentModelId = modelState.currentModelId;

      this.sessions.set(sessionKey, session);
      logger.info(`[Session] Created new session for user ${userId} in ${projectPath}`);
    }

    return this.sessions.get(sessionKey)!;
  }

  // ============ Session Queries ============

  getSession(
    userId: string,
    contextId: string | undefined,
    projectPath: string
  ): Session | undefined {
    const sessionKey = this.buildSessionKey(userId, contextId, projectPath);
    return this.sessions.get(sessionKey);
  }

  getSessionById(sessionId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId) {
        return session;
      }
    }
    return undefined;
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  hasSession(userId: string, contextId: string | undefined, projectPath: string): boolean {
    const sessionKey = this.buildSessionKey(userId, contextId, projectPath);
    return this.sessions.has(sessionKey);
  }

  // ============ Session Operations ============

  resolveInteraction(sessionId: string, requestId: string, optionIdOrIndex: string): IMResponse {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return {
        success: false,
        message: 'Session not found',
        card: this.createStatusCard('交互处理', '会话不存在', false),
      };
    }

    const pending = session.pendingInteractions.get(requestId);
    if (!pending) {
      return {
        success: false,
        message: 'Permission request not found or expired',
        card: this.createStatusCard('交互处理', '请求不存在或已过期', false),
      };
    }

    let finalOptionId = optionIdOrIndex;
    const options = pending.data.options;

    // 检查是否是序号
    const index = parseInt(optionIdOrIndex, 10);
    if (!isNaN(index) && index >= 0 && index < options.length) {
      finalOptionId = options[index].optionId;
    } else {
      const exists = options.some(o => o.optionId === optionIdOrIndex);
      if (!exists) {
        return {
          success: false,
          message: `无效的选项: ${optionIdOrIndex}`,
          card: this.createStatusCard('交互处理', `无效的选项: ${optionIdOrIndex}`, false),
        };
      }
    }

    pending.resolve(finalOptionId);
    session.pendingInteractions.delete(requestId);

    return {
      success: true,
      message: `已选择选项: ${finalOptionId}`,
      card: this.createStatusCard('交互处理', `已选择选项: ${finalOptionId}`),
    };
  }

  async resetSession(userId: string, contextId: string | undefined): Promise<IMResponse> {
    const projectPath = this.currentRepoInfo?.path || '';
    const sessionKey = this.buildSessionKey(userId, contextId, projectPath);
    const session = this.sessions.get(sessionKey);

    if (!session) {
      return {
        success: true,
        message: '🔄 会话重置完成（无活跃会话）',
        card: this.createStatusCard('重置会话', '会话重置完成（无活跃会话）'),
      };
    }

    const repoName = session.repoName || session.projectPath.split('/').pop() || 'unknown';

    // 停止 Agent
    if (session.acpClient) {
      await (session.acpClient as any).stop();
    }

    // 清理待处理交互
    for (const [requestId, interaction] of session.pendingInteractions) {
      interaction.reject('Session reset');
    }
    session.pendingInteractions.clear();

    // 清空队列
    session.queue.pending = [];
    session.queue.current = null;
    session.isProcessing = false;

    // 删除会话
    this.sessions.delete(sessionKey);

    return {
      success: true,
      message: `✅ 会话重置完成：${repoName}`,
      card: this.createStatusCard('重置会话', `✅ 会话重置完成：${repoName}`),
    };
  }

  async resetAllSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.acpClient) {
        await (session.acpClient as any).stop();
      }
    }
    this.sessions.clear();
    logger.info('[Session] All sessions reset');
  }

  // ============ Queue Operations ============

  getQueueStatus(userId: string, contextId: string | undefined): IMResponse {
    const projectPath = this.currentRepoInfo?.path || '';
    const session = this.getSession(userId, contextId, projectPath);

    if (!session) {
      return {
        success: true,
        message: '当前没有活跃的会话',
        card: this.createStatusCard('会话状态', '当前没有活跃的会话'),
      };
    }

    const repoName = session.repoName || session.projectPath.split('/').pop() || 'unknown';

    return {
      success: true,
      message: `📁 项目: ${repoName}\n📋 当前任务: ${session.queue.current ? '运行中' : '空闲'}\n📬 待执行队列: ${session.queue.pending.length} 个任务`,
      data: {
        repoName,
        projectPath: session.projectPath,
        agentStatus: { running: true },
        current: session.queue.current,
        pending: session.queue.pending,
        pendingCount: session.queue.pending.length,
        isProcessing: session.isProcessing,
      },
      card: {
        title: `📊 会话状态 - ${repoName}`,
        elements: [
          { type: 'markdown', content: `**📁 项目：** \`${repoName}\`` },
          {
            type: 'markdown',
            content: `**📋 当前任务：** ${session.isProcessing ? '运行中' : '🕐 空闲'}`,
          },
          {
            type: 'markdown',
            content: `**📬 待执行队列：** ${session.queue.pending.length} 个任务`,
          },
        ],
      },
    };
  }

  async stopTask(
    userId: string,
    taskId: string | undefined,
    contextId: string | undefined
  ): Promise<IMResponse> {
    const projectPath = this.currentRepoInfo?.path || '';
    const session = this.getSession(userId, contextId, projectPath);

    if (!session) {
      return {
        success: false,
        message: '当前没有活跃的会话',
        card: this.createStatusCard('停止任务', '当前没有活跃的会话', false),
      };
    }

    const repoName = session.repoName || session.projectPath.split('/').pop() || 'unknown';

    if (taskId === 'all') {
      const stoppedCurrent = session.queue.current !== null;
      if (session.queue.current && session.acpClient) {
        await (session.acpClient as any).cancelCurrentTask();
      }
      const queueCount = session.queue.pending.length;
      session.queue.pending = [];
      session.queue.current = null;
      session.isProcessing = false;

      return {
        success: true,
        message: `✅ 已停止当前任务，并清空队列中的 ${queueCount} 个待执行任务`,
        card: this.createStatusCard('停止任务', `✅ 已清空队列`),
      };
    }

    if (taskId) {
      const index = session.queue.pending.findIndex(t => t.id === taskId);
      if (index > -1) {
        const removedTask = session.queue.pending.splice(index, 1)[0];
        return {
          success: true,
          message: `✅ 已移除任务: ${removedTask.content.substring(0, 50)}...`,
          card: this.createStatusCard('移除任务', `✅ 已移除任务`),
        };
      }
      return {
        success: false,
        message: `❌ 未找到任务: ${taskId}`,
        card: this.createStatusCard('移除任务', `❌ 未找到任务`, false),
      };
    }

    // 默认停止当前任务
    if (session.queue.current && session.acpClient) {
      await (session.acpClient as any).cancelCurrentTask();
      session.queue.current = null;
      session.isProcessing = false;

      return {
        success: true,
        message: `✅ 已停止当前任务`,
        card: this.createStatusCard('停止任务', `✅ 已停止当前任务`),
      };
    }

    return {
      success: true,
      message: '🕐 没有正在运行的任务',
      card: this.createStatusCard('停止任务', '没有正在运行的任务'),
    };
  }

  // ============ Helper Methods ============

  private createStatusCard(title: string, message: string, success: boolean = true): UniversalCard {
    return {
      title: `${success ? '✅' : '❌'} ${title}`,
      elements: [{ type: 'markdown', content: message }],
    };
  }
}
