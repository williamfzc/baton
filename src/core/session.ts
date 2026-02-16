/**
 * 会话管理器
 * 维护对话级仓库游标（Conversation Cursor）与会话级执行状态（SessionKey）
 * 保证切仓库只影响后续路由，不影响已创建会话和已入队任务归属
 */
import type { Session, IMResponse, RepoInfo } from '../types';
import type { UniversalCard } from '../im/types';
import { ACPClient, type ACPLaunchConfig } from '../acp/client';
import { createLogger } from '../utils/logger';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RequestPermissionRequest, PermissionOption } from '@agentclientprotocol/sdk';
import { RepoManager } from './repo';
import { t } from '../i18n';

const logger = createLogger('SessionManager');
const REPO_OPTION_PREFIX = 'repo:';

// 简单的 UUID 生成函数
function generateUUID(): string {
  return randomUUID();
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private sessionsById = new Map<string, Session>();
  private conversationCursors = new Map<string, string>();
  private pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private permissionTimeout: number;
  private repoManager: RepoManager | null = null;
  private defaultRepoInfo: RepoInfo | null = null;
  private executor: string;
  private acpLaunchConfig?: ACPLaunchConfig;

  constructor(
    permissionTimeoutSeconds: number = 300,
    executor: string = 'opencode',
    acpLaunchConfig?: ACPLaunchConfig
  ) {
    super();
    this.permissionTimeout = permissionTimeoutSeconds * 1000;
    this.executor = executor;
    this.acpLaunchConfig = acpLaunchConfig;
  }

  setRepoManager(repoManager: RepoManager): void {
    this.repoManager = repoManager;
  }

  setCurrentRepo(repoInfo: RepoInfo): void {
    // 兼容旧接口：仅设置默认仓库，不做全局切换
    this.defaultRepoInfo = repoInfo;
  }

  getCurrentRepo(): RepoInfo | null {
    return this.defaultRepoInfo;
  }

  getRepoManager(): RepoManager | null {
    return this.repoManager;
  }

  private buildConversationKey(userId: string, contextId: string | undefined): string {
    return contextId ? `${userId}:${contextId}` : `${userId}:__default__`;
  }

  getConversationRepo(userId: string, contextId: string | undefined): RepoInfo | null {
    const cursor = this.conversationCursors.get(this.buildConversationKey(userId, contextId));
    if (!cursor) {
      return this.defaultRepoInfo;
    }
    return this.repoManager?.getRepoByPath(cursor) || this.defaultRepoInfo;
  }

  resolveProjectPath(userId: string, contextId: string | undefined): string {
    return this.getConversationRepo(userId, contextId)?.path || '';
  }

  switchConversationRepo(userId: string, contextId: string | undefined, repoInfo: RepoInfo): void {
    const key = this.buildConversationKey(userId, contextId);
    this.conversationCursors.set(key, repoInfo.path);
    if (!this.defaultRepoInfo) {
      this.defaultRepoInfo = repoInfo;
    }
  }

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
        contextId,
        projectPath,
        repoName:
          this.repoManager?.getRepoByPath(projectPath)?.name ||
          this.defaultRepoInfo?.name ||
          path.basename(projectPath),
        acpClient: null,
        queue: {
          pending: [],
          current: null,
        },
        isProcessing: false,
        state: 'IDLE',
        availableModes: [],
        availableModels: [],
        pendingInteractions: new Map(),
      };
      this.sessions.set(sessionKey, session);
      this.sessionsById.set(session.id, session);
      logger.info(`[Session] Created new session for user ${userId} in ${projectPath}`);
    }

    const session = this.sessions.get(sessionKey)!;

    // 确保 agent 进程已启动
    if (!session.acpClient) {
      logger.info(`[Session] Starting agent for session ${session.id}`);

      // 定义权限处理函数
      const permissionHandler = async (req: RequestPermissionRequest): Promise<string> => {
        return new Promise<string>((resolve, reject) => {
          const requestId = generateUUID();

          // 每个会话最多一个 pending interaction，避免多交互串扰
          if (session.pendingInteractions.size > 0) {
            for (const [existingId, existing] of session.pendingInteractions.entries()) {
              this.clearPendingTimeout(existingId);
              existing.reject('replaced by new interaction');
              session.pendingInteractions.delete(existingId);
            }
          }

          session.pendingInteractions.set(requestId, {
            type: 'permission',
            resolve,
            reject,
            timestamp: Date.now(),
            data: {
              title: req.toolCall.title ?? t('core', 'permissionRequestTitle'),
              options: req.options.map(o => ({ optionId: o.optionId, name: o.name })),
              originalRequest: req,
            },
          });

          logger.info(
            { sessionId: session.id, requestId, tool: req.toolCall.title },
            'Permission requested, waiting for user...'
          );
          session.state = 'WAITING_CONFIRM';

          // 触发事件通知 IM 层
          this.emit('permissionRequest', {
            sessionId: session.id,
            requestId,
            userId: session.userId,
            request: req,
          });

          // 设置超时自动拒绝
          const timeout = setTimeout(() => {
            if (session.pendingInteractions.has(requestId)) {
              const pending = session.pendingInteractions.get(requestId);
              const fallbackOption =
                req.options.find(
                  (o: PermissionOption) =>
                    o.name.toLowerCase().includes('deny') || o.name.toLowerCase().includes('cancel')
                )?.optionId ||
                req.options[0]?.optionId ||
                'deny';
              pending?.resolve(fallbackOption);
              session.pendingInteractions.delete(requestId);
              session.state = session.queue.current ? 'RUNNING' : 'IDLE';
              logger.warn({ sessionId: session.id, requestId }, 'Permission request timed out');
            }
            this.pendingTimeouts.delete(requestId);
          }, this.permissionTimeout);
          this.pendingTimeouts.set(requestId, timeout);
        });
      };

      const acpClient = new ACPClient(
        session.projectPath,
        permissionHandler,
        this.executor,
        this.acpLaunchConfig
      );
      await acpClient.startAgent();
      session.acpClient = acpClient;

      // 同步初始状态
      const modeState = acpClient.getModeState();
      const modelState = acpClient.getModelState();
      session.availableModes = modeState.availableModes;
      session.currentModeId = modeState.currentModeId;
      session.availableModels = modelState.availableModels;
      session.currentModelId = modelState.currentModelId;
    }

    return session;
  }

  private clearPendingTimeout(requestId: string): void {
    const timeout = this.pendingTimeouts.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(requestId);
    }
  }

  private normalizeInteractionOption(
    options: Array<{ optionId: string; name: string }>,
    input: string
  ): { optionId: string } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const index = parseInt(trimmed, 10);
    if (!isNaN(index)) {
      if (index >= 0 && index < options.length) {
        return { optionId: options[index].optionId };
      }
      const oneBasedIndex = index - 1;
      if (oneBasedIndex >= 0 && oneBasedIndex < options.length) {
        return { optionId: options[oneBasedIndex].optionId };
      }
      return null;
    }

    const normalized = trimmed.toLowerCase();
    const matchedById = options.find(o => o.optionId.toLowerCase() === normalized);
    if (matchedById) {
      return { optionId: matchedById.optionId };
    }
    const matchedByName = options.find(o => o.name.trim().toLowerCase() === normalized);
    if (matchedByName) {
      return { optionId: matchedByName.optionId };
    }

    return null;
  }

  async tryResolveInteraction(sessionId: string, input: string): Promise<IMResponse | null> {
    const session = this.sessionsById.get(sessionId);
    if (!session || session.pendingInteractions.size === 0) {
      return null;
    }

    for (const [requestId, interaction] of session.pendingInteractions) {
      const normalized = this.normalizeInteractionOption(interaction.data.options, input);
      if (normalized) {
        return await this.resolveInteraction(sessionId, requestId, normalized.optionId);
      }
    }

    return null;
  }

  // 处理权限确认结果
  async resolveInteraction(
    sessionId: string,
    requestId: string,
    optionIdOrIndex: string
  ): Promise<IMResponse> {
    const session = this.sessionsById.get(sessionId);

    if (!session) {
      return {
        success: false,
        message: t('core', 'sessionNotFound'),
        card: this.createStatusCard(
          t('core', 'interactionTitle'),
          t('core', 'sessionMissing'),
          false
        ),
      };
    }

    const pending = session.pendingInteractions.get(requestId);
    if (!pending) {
      return {
        success: false,
        message: t('core', 'permissionRequestMissing'),
        card: this.createStatusCard(
          t('core', 'interactionTitle'),
          t('core', 'permissionRequestExpired'),
          false
        ),
      };
    }

    const options = pending.data.options;
    const normalized = this.normalizeInteractionOption(options, optionIdOrIndex);
    if (!normalized) {
      return {
        success: false,
        message: `${t('core', 'invalidOptionPrefix')}${optionIdOrIndex}${t(
          'core',
          'invalidOptionOptionsPrefix'
        )}${options.map(o => o.optionId).join(', ')}${t(
          'core',
          'invalidOptionOptionsSuffix'
        )}${options.length}`,
        card: this.createStatusCard(
          t('core', 'interactionTitle'),
          `${t('core', 'invalidOptionPrefix')}${optionIdOrIndex}`,
          false
        ),
      };
    }
    const finalOptionId = normalized.optionId;

    // 对于 repo_selection 类型，通过 Promise 回调返回结果，这里只负责触发回调
    if (pending.type === 'repo_selection') {
      const repoManager = this.getRepoManager();
      if (repoManager) {
        const repoIdentifier = finalOptionId.startsWith(REPO_OPTION_PREFIX)
          ? finalOptionId.slice(REPO_OPTION_PREFIX.length)
          : finalOptionId;
        const targetRepo = repoManager.findRepo(repoIdentifier);
        if (targetRepo) {
          this.switchConversationRepo(session.userId, session.contextId, targetRepo);
          this.clearPendingTimeout(requestId);
          pending.resolve(finalOptionId);
          session.pendingInteractions.delete(requestId);
          session.state = session.queue.current ? 'RUNNING' : 'IDLE';
          logger.info(
            { sessionId, requestId, finalOptionId, repoName: targetRepo.name },
            'Repository switched'
          );
          // 返回切换成功卡片（Promise 返回空响应）
          return {
            success: true,
            message: `${t('core', 'repoSwitchedPrefix')}${targetRepo.name}`,
            card: {
              title: t('core', 'repoSwitchSuccessTitle'),
              elements: [
                {
                  type: 'markdown',
                  content: `${t('core', 'repoSwitchSuccessCardPrefix')}${targetRepo.name}${t(
                    'core',
                    'repoSwitchSuccessCardSuffix'
                  )}`,
                },
                {
                  type: 'markdown',
                  content: `${t('core', 'repoPathLabel')}\`${targetRepo.path}\``,
                },
                {
                  type: 'markdown',
                  content: t('core', 'repoSwitchSessionHint'),
                },
              ],
            },
          };
        }
      }
      this.clearPendingTimeout(requestId);
      pending.resolve(finalOptionId);
      session.pendingInteractions.delete(requestId);
      session.state = session.queue.current ? 'RUNNING' : 'IDLE';
      return {
        success: false,
        message: `${t('core', 'repoNotFoundPrefix')}${finalOptionId}`,
        card: this.createStatusCard(
          t('core', 'repoSwitchTitle'),
          `${t('core', 'repoNotFoundPrefix')}${finalOptionId}`,
          false
        ),
      };
    }

    // 其他类型：执行回调并返回通用确认卡片
    this.clearPendingTimeout(requestId);
    pending.resolve(finalOptionId);
    session.pendingInteractions.delete(requestId);
    session.state = session.queue.current ? 'RUNNING' : 'IDLE';

    logger.info({ sessionId, requestId, finalOptionId }, 'Interaction resolved by user');
    return {
      success: true,
      message: `${t('core', 'selectedOptionPrefix')}${finalOptionId}`,
      card: this.createStatusCard(
        t('core', 'interactionTitle'),
        `${t('core', 'selectedOptionPrefix')}${finalOptionId}`
      ),
    };
  }

  // 创建仓库选择交互
  async createRepoSelection(
    userId: string,
    contextId: string | undefined,
    repos: { index: number; name: string; path: string }[]
  ): Promise<IMResponse> {
    const projectPath = this.resolveProjectPath(userId, contextId);
    const session = await this.getOrCreateSession(userId, contextId, projectPath);

    // 检查是否已有待处理的交互
    if (session.pendingInteractions.size > 0) {
      return {
        success: false,
        message: t('core', 'repoSelectionPending'),
        card: this.createStatusCard(
          t('core', 'repoSelectionTitle'),
          t('core', 'repoSelectionPending'),
          false
        ),
      };
    }

    // 使用 Promise 等待用户选择（不立即 resolve）
    const currentRepo = this.getConversationRepo(userId, contextId);
    const listCard: IMResponse = {
      success: true,
      message: t('core', 'repoSelectPrompt'),
      card: {
        title: t('core', 'repoSelectCardTitle'),
        elements: [
          ...(currentRepo
            ? [
                {
                  type: 'markdown' as const,
                  content: `${t('core', 'repoSelectCurrentPrefix')}${currentRepo.name}${t(
                    'core',
                    'repoSelectCurrentSuffix'
                  )}`,
                },
                {
                  type: 'hr' as const,
                },
              ]
            : []),
          {
            type: 'markdown' as const,
            content: t('core', 'repoSelectInstruction'),
          },
          {
            type: 'markdown' as const,
            content: repos.map((r, idx) => `${idx + 1}. ${r.name}`).join('\n'),
          },
          {
            type: 'markdown' as const,
            content: t('core', 'repoSelectHint'),
          },
        ],
      },
    };

    // 设置 pendingInteraction，Promise 会在用户选择后 resolve
    return new Promise(resolve => {
      const requestId = generateUUID();
      session.state = 'WAITING_CONFIRM';
      session.pendingInteractions.set(requestId, {
        type: 'repo_selection',
        resolve: async _optionId => {
          // Promise 回调只返回空响应，实际逻辑已在 resolveInteraction 中完成
          resolve({
            success: true,
            message: '',
          });
        },
        reject: () =>
          resolve({
            success: false,
            message: t('core', 'cancelled'),
            card: this.createStatusCard(
              t('core', 'repoSelectionTitle'),
              t('core', 'cancelled'),
              false
            ),
          }),
        timestamp: Date.now(),
        data: {
          title: t('core', 'repoSelectTitle'),
          options: repos.map(r => ({ optionId: `${REPO_OPTION_PREFIX}${r.index}`, name: r.name })),
        },
      });

      // 触发事件发送选择列表卡片（不 resolve Promise）
      this.emit('selectionPrompt', { sessionId: session.id, requestId, response: listCard });
    });
  }

  getSession(
    userId: string,
    contextId: string | undefined,
    projectPath: string
  ): Session | undefined {
    const sessionKey = this.buildSessionKey(userId, contextId, projectPath);
    return this.sessions.get(sessionKey);
  }

  getSessionById(sessionId: string): Session | undefined {
    return this.sessionsById.get(sessionId);
  }

  async resetSession(userId: string, contextId: string | undefined): Promise<IMResponse> {
    const projectPath = this.resolveProjectPath(userId, contextId);
    const sessionKey = this.buildSessionKey(userId, contextId, projectPath);
    const session = this.sessions.get(sessionKey);

    if (!session) {
      return {
        success: true,
        message: t('core', 'resetNoSessionMessage'),
        card: this.createStatusCard(
          t('core', 'resetSessionTitle'),
          t('core', 'resetNoSessionCardMessage')
        ),
      };
    }

    const repoName = session.repoName || path.basename(session.projectPath);

    let wasRunning = false;
    let pid: number | undefined;
    if (session.acpClient && typeof session.acpClient.getAgentStatus === 'function') {
      const agentStatus = session.acpClient.getAgentStatus();
      wasRunning = agentStatus.running;
      pid = agentStatus.pid;
    } else if (session.acpClient) {
      wasRunning = true;
    }

    // 1. 取消当前任务
    if (session.queue.current && session.acpClient) {
      await session.acpClient.cancelCurrentTask();
    }

    // 2. 停止 Agent 进程
    if (session.acpClient) {
      await session.acpClient.stop();
    }

    // 3. 清理所有待处理交互
    const pendingCount = session.pendingInteractions.size;
    for (const [requestId, interaction] of session.pendingInteractions) {
      this.clearPendingTimeout(requestId);
      interaction.reject('Session reset');
      session.pendingInteractions.delete(requestId);
    }

    // 4. 清空队列
    const queueCount = session.queue.pending.length;
    session.queue.pending = [];
    session.queue.current = null;
    session.isProcessing = false;
    session.state = 'IDLE';

    // 5. 删除会话
    this.sessions.delete(sessionKey);
    this.sessionsById.delete(session.id);

    logger.info({ userId, contextId, repoName, wasRunning, pid }, 'Session reset complete');

    const elements: { type: 'markdown'; content: string }[] = [
      {
        type: 'markdown',
        content: t('core', 'resetCompleteLabel'),
      },
      {
        type: 'markdown',
        content: `${t('core', 'resetProjectLabel')}\`${repoName}\``,
      },
    ];

    if (wasRunning && pid) {
      elements.push({
        type: 'markdown',
        content: `${t('core', 'resetAgentStoppedPrefix')}\`${pid}\`${t(
          'core',
          'resetAgentStoppedSuffix'
        )}`,
      });
    }

    if (pendingCount > 0) {
      elements.push({
        type: 'markdown',
        content: `${t('core', 'resetInteractionsClearedPrefix')}${pendingCount}${t(
          'core',
          'resetInteractionsClearedSuffix'
        )}`,
      });
    }

    if (queueCount > 0) {
      elements.push({
        type: 'markdown',
        content: `${t('core', 'resetQueueClearedPrefix')}${queueCount}${t(
          'core',
          'resetQueueClearedSuffix'
        )}`,
      });
    }

    elements.push({
      type: 'markdown',
      content: t('core', 'resetNextSessionHint'),
    });

    return {
      success: true,
      message: `${t('core', 'resetMessagePrefix')}${repoName}${t(
        'core',
        'resetMessageMid'
      )}${queueCount}${t('core', 'resetMessageQueueSuffix')}${pendingCount}${t(
        'core',
        'resetMessagePendingSuffix'
      )}`,
      card: {
        title: `${t('core', 'resetCardTitlePrefix')}${repoName}`,
        elements,
      },
    };
  }

  getQueueStatus(userId: string, contextId: string | undefined): IMResponse {
    const projectPath = this.resolveProjectPath(userId, contextId);
    const session = this.getSession(userId, contextId, projectPath);
    if (!session) {
      return {
        success: true,
        message: t('core', 'noActiveSessionMessage'),
        card: this.createStatusCard(
          t('core', 'sessionStatusTitle'),
          t('core', 'noActiveSessionMessage')
        ),
      };
    }

    // 获取 Agent 状态
    let pid: number | undefined;
    let running = false;
    if (session.acpClient && typeof session.acpClient.getAgentStatus === 'function') {
      const agentStatus = session.acpClient.getAgentStatus();
      pid = agentStatus.pid;
      running = agentStatus.running;
    } else if (session.acpClient) {
      // 如果 acpClient 存在但没有 getAgentStatus 方法，假设运行中
      running = true;
    }

    // 构建状态信息
    const statusIcon = running ? '🟢' : '🔴';
    const statusText = running ? t('core', 'statusRunning') : t('core', 'statusStopped');
    const repoName = session.repoName || path.basename(session.projectPath);
    const waitingCount = session.pendingInteractions.size;
    const planStatus =
      session.acpClient && typeof session.acpClient.getPlanStatus === 'function'
        ? session.acpClient.getPlanStatus()
        : null;

    // 构建卡片元素
    const elements: { type: 'markdown'; content: string }[] = [
      {
        type: 'markdown' as const,
        content: `${t('core', 'statusCardProjectLabel')}\`${repoName}\`\n${t(
          'core',
          'statusCardPathLabel'
        )}\`${session.projectPath}\``,
      },
      {
        type: 'markdown' as const,
        content: `${t('core', 'statusCardExecutorLabel')}\`${this.executor}\``,
      },
      {
        type: 'markdown' as const,
        content: `${t('core', 'statusCardAgentLabel')}${statusIcon} ${statusText}${
          pid ? ` | ${t('core', 'statusCardPidLabel')}\`${pid}\`` : ''
        }`,
      },
      {
        type: 'markdown' as const,
        content: `${t('core', 'statusCardSessionLabel')}\`${session.state}\` | ${t(
          'core',
          'statusCardPendingLabel'
        )}${waitingCount}`,
      },
    ];

    if (planStatus && planStatus.entries.length > 0) {
      const formatStatusEmoji = (status: string): string => {
        const normalized = status.toLowerCase();
        if (normalized === 'completed' || normalized === 'done') return '✅';
        if (
          normalized === 'in_progress' ||
          normalized === 'in-progress' ||
          normalized === 'running' ||
          normalized === 'active'
        )
          return '🚧';
        if (
          normalized === 'pending' ||
          normalized === 'todo' ||
          normalized === 'not_started' ||
          normalized === 'not-started'
        )
          return '⏳';
        return '❔';
      };
      const formatPriorityEmoji = (priority: string): string => {
        const normalized = priority.toLowerCase();
        if (normalized === 'high') return '🔥';
        if (normalized === 'medium') return '⚖️';
        if (normalized === 'low') return '🧊';
        return '📌';
      };
      const planList = planStatus.entries
        .map(
          (entry, idx) =>
            `${idx + 1}. ${formatStatusEmoji(entry.status)}${formatPriorityEmoji(entry.priority)} ${entry.content.substring(0, 90)}${entry.content.length > 90 ? '...' : ''}`
        )
        .join('\n');
      const currentStep = planStatus.current?.content
        ? `\n${t('core', 'statusCardCurrentStepLabel')}${planStatus.current.content.substring(0, 100)}${
            planStatus.current.content.length > 100 ? '...' : ''
          }`
        : '';
      elements.push({
        type: 'markdown' as const,
        content: `${t('core', 'statusCardPlanLabel')}${planStatus.summary}\n${planList}${currentStep}`,
      });
    } else {
      elements.push({
        type: 'markdown' as const,
        content: `${t('core', 'statusCardPlanLabel')}${t('core', 'statusCardPlanEmpty')}`,
      });
    }

    // 当前任务
    if (session.queue.current) {
      elements.push({
        type: 'markdown' as const,
        content: `${t('core', 'statusCardCurrentTaskLabel')}\n\`\`\`\n${session.queue.current.content.substring(
          0,
          100
        )}${session.queue.current.content.length > 100 ? '...' : ''}\n\`\`\`\n${t(
          'core',
          'statusCardTaskIdLabel'
        )}\`${session.queue.current.id.substring(0, 8)}...\``,
      });
    } else {
      elements.push({
        type: 'markdown' as const,
        content: `${t('core', 'statusCardCurrentTaskLabel')} ${t('core', 'statusCardCurrentTaskIdle')}`,
      });
    }

    // 待执行队列
    const queueList = session.queue.pending
      .map(
        (task, idx) =>
          `${idx + 1}. \`${task.content.substring(0, 50)}${task.content.length > 50 ? '...' : ''}\``
      )
      .join('\n');
    elements.push({
      type: 'markdown' as const,
      content:
        session.queue.pending.length > 0
          ? `${t('core', 'statusCardQueuePrefix')}${session.queue.pending.length}${t(
              'core',
              'statusCardQueueSuffix'
            )}\n${queueList}`
          : `${t('core', 'statusCardQueuePrefix')}0${t(
              'core',
              'statusCardQueueSuffix'
            )}\n${t('core', 'statusCardQueueEmptyItem')}`,
    });

    const card: UniversalCard = {
      title: `${t('core', 'statusCardTitlePrefix')}${repoName}`,
      elements: elements,
    };

    // 构建文本消息（兼容非卡片客户端）
    let messageText = `${t('core', 'statusTextProjectLabel')}${repoName}\n`;
    messageText += `${t('core', 'statusTextPathLabel')}${session.projectPath}\n`;
    messageText += `${t('core', 'statusTextExecutorLabel')}${this.executor}\n`;
    messageText += `${t('core', 'statusTextAgentLabel')}${statusText}${
      pid ? ` (${t('core', 'statusTextPidLabel')}${pid})` : ''
    }\n`;
    messageText += `${t('core', 'statusTextSessionLabel')}${session.state}${t(
      'core',
      'statusTextPendingLabel'
    )}${waitingCount}\n`;
    if (planStatus && planStatus.entries.length > 0) {
      messageText += `${t('core', 'statusTextPlanLabel')}${planStatus.summary}\n`;
      const textList = planStatus.entries
        .slice(0, 5)
        .map((entry, idx) => `${idx + 1}. [${entry.status}/${entry.priority}] ${entry.content}`)
        .join('\n');
      if (textList) {
        messageText += `${textList}\n`;
      }
      if (planStatus.current?.content) {
        messageText += `${t('core', 'statusTextCurrentStepLabel')}${planStatus.current.content.substring(
          0,
          50
        )}${planStatus.current.content.length > 50 ? '...' : ''}\n`;
      }
    } else {
      messageText += `${t('core', 'statusTextPlanLabel')}${t('core', 'statusTextPlanEmpty')}\n`;
    }
    if (session.queue.current) {
      messageText += `${t('core', 'statusTextCurrentTaskLabel')}${session.queue.current.content.substring(
        0,
        50
      )}...\n`;
    } else {
      messageText += `${t('core', 'statusTextCurrentTaskLabel')}${t(
        'core',
        'statusTextCurrentTaskIdle'
      )}\n`;
    }
    messageText += `${t('core', 'statusTextQueueLabel')}${session.queue.pending.length}${t(
      'core',
      'statusTextQueueSuffix'
    )}`;

    return {
      success: true,
      message: messageText,
      data: {
        repoName,
        projectPath: session.projectPath,
        executor: this.executor,
        agentStatus: { pid, running },
        current: session.queue.current,
        pending: session.queue.pending,
        pendingCount: session.queue.pending.length,
        isProcessing: session.isProcessing,
        state: session.state,
        planStatus,
      },
      card,
    };
  }

  // 辅助方法：创建状态卡片
  private createStatusCard(title: string, message: string, success: boolean = true): UniversalCard {
    return {
      title: `${success ? '✅' : '❌'} ${title}`,
      elements: [
        {
          type: 'markdown',
          content: message,
        },
      ],
    };
  }

  async stopTask(
    userId: string,
    taskId: string | undefined,
    contextId: string | undefined
  ): Promise<IMResponse> {
    const projectPath = this.resolveProjectPath(userId, contextId);
    const session = this.getSession(userId, contextId, projectPath);
    if (!session) {
      return {
        success: false,
        message: t('core', 'noActiveSessionMessage'),
        card: this.createStatusCard(
          t('core', 'stopTaskTitle'),
          t('core', 'noActiveSessionMessage'),
          false
        ),
      };
    }

    const repoName = session.repoName || path.basename(session.projectPath);

    if (taskId === 'all') {
      // 停止当前任务并清空队列
      const stoppedCurrent = session.queue.current !== null;
      if (session.queue.current && session.acpClient) {
        await session.acpClient.cancelCurrentTask();
      }
      const queueCount = session.queue.pending.length;
      session.queue.pending = [];
      session.queue.current = null;
      session.isProcessing = false;
      session.state = 'STOPPED';

      const message = stoppedCurrent
        ? `${t('core', 'stopAllWithCurrentPrefix')}${queueCount}${t(
            'core',
            'stopAllWithCurrentSuffix'
          )}`
        : `${t('core', 'stopAllQueueOnlyPrefix')}${queueCount}${t(
            'core',
            'stopAllQueueOnlySuffix'
          )}`;

      return {
        success: true,
        message,
        card: {
          title: `${t('core', 'stopTaskCardTitlePrefix')}${repoName}`,
          elements: [
            {
              type: 'markdown',
              content: message,
            },
            {
              type: 'markdown',
              content: t('core', 'queueIdleStatus'),
            },
          ],
        },
      };
    }

    if (taskId) {
      // 移除指定任务
      const index = session.queue.pending.findIndex(t => t.id === taskId);
      if (index > -1) {
        const removedTask = session.queue.pending.splice(index, 1)[0];
        return {
          success: true,
          message: `${t('core', 'removeTaskMessagePrefix')}${removedTask.content.substring(0, 50)}...`,
          card: {
            title: `${t('core', 'removeTaskTitlePrefix')}${repoName}`,
            elements: [
              {
                type: 'markdown',
                content: `${t('core', 'removeTaskCardIntro')}\n\`\`\`\n${removedTask.content.substring(
                  0,
                  100
                )}${removedTask.content.length > 100 ? '...' : ''}\n\`\`\``,
              },
              {
                type: 'markdown',
                content: `${t('core', 'taskIdLabel')}\`${taskId.substring(0, 8)}...\`\n${t(
                  'core',
                  'remainingTasksLabel'
                )}**${session.queue.pending.length}**`,
              },
            ],
          },
        };
      }
      return {
        success: false,
        message: `${t('core', 'taskNotFoundPrefix')}${taskId}`,
        card: this.createStatusCard(
          t('core', 'removeTaskTitle'),
          `${t('core', 'taskNotFoundPrefix')}${taskId.substring(0, 8)}...`,
          false
        ),
      };
    }

    // 默认停止当前任务
    if (session.queue.current && session.acpClient) {
      const stoppedTask = session.queue.current;
      await session.acpClient.cancelCurrentTask();
      session.queue.current = null;
      session.isProcessing = false;
      session.state = 'IDLE';

      // 如果队列还有任务，自动开始下一个
      if (session.queue.pending.length > 0) {
        // 注意：这里不自动执行下一个，由队列引擎处理
      }

      return {
        success: true,
        message: t('core', 'stopCurrentTaskMessage'),
        card: {
          title: `${t('core', 'stopTaskCardTitlePrefix')}${repoName}`,
          elements: [
            {
              type: 'markdown',
              content: t('core', 'stopCurrentTaskCardMessage'),
            },
            {
              type: 'markdown',
              content: `${t('core', 'stoppedTaskLabel')}\`${stoppedTask.content.substring(0, 50)}...\`\n${t(
                'core',
                'remainingQueueLabel'
              )}**${session.queue.pending.length}**`,
            },
          ],
        },
      };
    }

    return {
      success: true,
      message: t('core', 'noRunningTaskMessage'),
      card: this.createStatusCard(
        t('core', 'stopTaskTitle'),
        t('core', 'noRunningTaskCardMessage')
      ),
    };
  }

  // 触发模式选择
  async triggerModeSelection(userId: string, contextId: string | undefined): Promise<IMResponse> {
    const projectPath = this.resolveProjectPath(userId, contextId);
    const session = await this.getOrCreateSession(userId, contextId, projectPath);

    // 检查是否已有待处理的权限请求
    if (session.pendingInteractions.size > 0) {
      return {
        success: false,
        message: t('core', 'pendingPermissionExists'),
        card: this.createStatusCard(
          t('core', 'modeSwitchTitle'),
          t('core', 'pendingPermissionExists'),
          false
        ),
      };
    }

    const state = session.acpClient?.getModeState();

    if (!state || state.availableModes.length === 0) {
      return {
        success: false,
        message: t('core', 'modeSwitchNotSupported'),
        card: this.createStatusCard(
          t('core', 'modeSwitchTitle'),
          t('core', 'modeSwitchNotSupported'),
          false
        ),
      };
    }

    // 构建一个模拟的权限请求来复用选择逻辑
    const fakeReq: RequestPermissionRequest = {
      sessionId: session.id,
      toolCall: {
        title: `${t('core', 'modeSwitchPromptPrefix')}${
          state.currentModeId || t('core', 'unknownValue')
        }${t('core', 'modeSwitchPromptSuffix')}`,
        toolCallId: 'internal',
      },
      options: state.availableModes.map(m => ({
        optionId: m.id,
        name: m.name || m.id,
        kind: 'allow_once',
      })),
    };

    return new Promise(resolve => {
      const requestId = generateUUID();
      session.state = 'WAITING_CONFIRM';
      session.pendingInteractions.set(requestId, {
        type: 'mode_selection',
        resolve: async optionId => {
          if (session.acpClient) {
            const res = await session.acpClient.setMode(optionId);
            session.currentModeId = optionId;
            resolve({
              ...res,
              card: res.success
                ? {
                    title: t('core', 'modeSwitchSuccessTitle'),
                    elements: [
                      {
                        type: 'markdown',
                        content: `${t('core', 'modeSwitchedPrefix')}${optionId}${t(
                          'core',
                          'modeSwitchedSuffix'
                        )}`,
                      },
                    ],
                  }
                : this.createStatusCard(t('core', 'modeSwitchTitle'), res.message, false),
            });
          }
        },
        reject: () =>
          resolve({
            success: false,
            message: t('core', 'cancelled'),
            card: this.createStatusCard(
              t('core', 'modeSelectionTitle'),
              t('core', 'cancelled'),
              false
            ),
          }),
        timestamp: Date.now(),
        data: {
          title: fakeReq.toolCall.title ?? t('core', 'selectDefaultTitle'),
          options: fakeReq.options.map(o => ({ optionId: o.optionId, name: o.name })),
        },
      });

      this.emit('permissionRequest', {
        sessionId: session.id,
        requestId,
        userId: session.userId,
        request: fakeReq,
      });
    });
  }

  // 触发模型选择
  async triggerModelSelection(userId: string, contextId: string | undefined): Promise<IMResponse> {
    const projectPath = this.resolveProjectPath(userId, contextId);
    const session = await this.getOrCreateSession(userId, contextId, projectPath);

    // 检查是否已有待处理的权限请求
    if (session.pendingInteractions.size > 0) {
      return {
        success: false,
        message: t('core', 'pendingPermissionExists'),
        card: this.createStatusCard(
          t('core', 'modelSwitchTitle'),
          t('core', 'pendingPermissionExists'),
          false
        ),
      };
    }

    const state = session.acpClient?.getModelState();

    if (!state || state.availableModels.length === 0) {
      return {
        success: false,
        message: t('core', 'modelSwitchNotSupported'),
        card: this.createStatusCard(
          t('core', 'modelSwitchTitle'),
          t('core', 'modelSwitchNotSupported'),
          false
        ),
      };
    }

    // 构建一个模拟的权限请求来复用选择逻辑
    const fakeReq: RequestPermissionRequest = {
      sessionId: session.id,
      toolCall: {
        title: `${t('core', 'modelSwitchPromptPrefix')}${
          state.currentModelId || t('core', 'unknownValue')
        }${t('core', 'modelSwitchPromptSuffix')}`,
        toolCallId: 'internal',
      },
      options: state.availableModels.map(m => ({
        optionId: m.modelId,
        name: m.name || m.modelId,
        kind: 'allow_once',
      })),
    };

    return new Promise(resolve => {
      const requestId = generateUUID();
      session.state = 'WAITING_CONFIRM';
      session.pendingInteractions.set(requestId, {
        type: 'model_selection',
        resolve: async optionId => {
          if (session.acpClient) {
            const res = await session.acpClient.setModel(optionId);
            session.currentModelId = optionId;
            resolve({
              ...res,
              card: res.success
                ? {
                    title: t('core', 'modelSwitchSuccessTitle'),
                    elements: [
                      {
                        type: 'markdown',
                        content: `${t('core', 'modelSwitchedPrefix')}${optionId}${t(
                          'core',
                          'modelSwitchedSuffix'
                        )}`,
                      },
                    ],
                  }
                : this.createStatusCard(t('core', 'modelSwitchTitle'), res.message, false),
            });
          }
        },
        reject: () =>
          resolve({
            success: false,
            message: t('core', 'cancelled'),
            card: this.createStatusCard(
              t('core', 'modelSelectionTitle'),
              t('core', 'cancelled'),
              false
            ),
          }),
        timestamp: Date.now(),
        data: {
          title: fakeReq.toolCall.title ?? t('core', 'selectDefaultTitle'),
          options: fakeReq.options.map(o => ({ optionId: o.optionId, name: o.name })),
        },
      });

      this.emit('permissionRequest', {
        sessionId: session.id,
        requestId,
        userId: session.userId,
        request: fakeReq,
      });
    });
  }

  async resetAllSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.acpClient) {
        await session.acpClient.stop();
      }
    }
    this.sessions.clear();
    this.conversationCursors.clear();
    logger.info('[Session] All sessions reset');
  }
}
