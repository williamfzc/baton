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
import type { RequestPermissionRequest, PermissionOption } from '@agentclientprotocol/sdk';
import { RepoManager } from './repo';

const logger = createLogger('SessionManager');
const REPO_OPTION_PREFIX = 'repo:';

// 简单的 UUID 生成函数
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private conversationCursors = new Map<string, string>();
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
              title: req.toolCall.title ?? '权限请求',
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
          setTimeout(() => {
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
          }, this.permissionTimeout);
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

  // 处理权限确认结果
  async resolveInteraction(
    sessionId: string,
    requestId: string,
    optionIdOrIndex: string
  ): Promise<IMResponse> {
    // 查找 session
    let session: Session | undefined;
    for (const s of this.sessions.values()) {
      if (s.id === sessionId) {
        session = s;
        break;
      }
    }

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

    // 检查是否是数字输入：
    // 兼容历史行为（0-based）与当前交互习惯（1-based）
    const index = parseInt(optionIdOrIndex, 10);
    if (!isNaN(index)) {
      if (index >= 0 && index < options.length) {
        // 兼容历史测试/行为：输入 0..N-1 直接按数组下标处理
        finalOptionId = options[index].optionId;
      } else {
        const oneBasedIndex = index - 1;
        if (oneBasedIndex >= 0 && oneBasedIndex < options.length) {
          finalOptionId = options[oneBasedIndex].optionId;
        } else {
          return {
            success: false,
            message: `无效的选项: ${optionIdOrIndex}。可选: ${options.map(o => o.optionId).join(', ')} 或序号 1-${options.length}`,
            card: this.createStatusCard('交互处理', `无效的选项: ${optionIdOrIndex}`, false),
          };
        }
      }
    } else {
      const normalizedInput = optionIdOrIndex.trim().toLowerCase();
      const matchedById = options.find(o => o.optionId.toLowerCase() === normalizedInput);
      const matchedByName = options.find(o => o.name.trim().toLowerCase() === normalizedInput);
      if (matchedById) {
        finalOptionId = matchedById.optionId;
      } else if (matchedByName) {
        finalOptionId = matchedByName.optionId;
      } else {
        return {
          success: false,
          message: `无效的选项: ${optionIdOrIndex}。可选: ${options.map(o => o.optionId).join(', ')} 或序号 1-${options.length}`,
          card: this.createStatusCard('交互处理', `无效的选项: ${optionIdOrIndex}`, false),
        };
      }
    }

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
            message: `🔄 已切换到仓库: ${targetRepo.name}`,
            card: {
              title: '📦 仓库切换成功',
              elements: [
                {
                  type: 'markdown',
                  content: `✅ 已切换到仓库：**${targetRepo.name}**`,
                },
                {
                  type: 'markdown',
                  content: `📂 路径: \`${targetRepo.path}\``,
                },
                {
                  type: 'markdown',
                  content: '💡 新的会话将在下次发送消息时自动创建',
                },
              ],
            },
          };
        }
      }
      pending.resolve(finalOptionId);
      session.pendingInteractions.delete(requestId);
      session.state = session.queue.current ? 'RUNNING' : 'IDLE';
      return {
        success: false,
        message: `未找到仓库: ${finalOptionId}`,
        card: this.createStatusCard('仓库切换', `未找到仓库: ${finalOptionId}`, false),
      };
    }

    // 其他类型：执行回调并返回通用确认卡片
    pending.resolve(finalOptionId);
    session.pendingInteractions.delete(requestId);
    session.state = session.queue.current ? 'RUNNING' : 'IDLE';

    logger.info({ sessionId, requestId, finalOptionId }, 'Interaction resolved by user');
    return {
      success: true,
      message: `已选择选项: ${finalOptionId}`,
      card: this.createStatusCard('交互处理', `已选择选项: ${finalOptionId}`),
    };
  }

  // 创建仓库选择交互
  async createRepoSelection(
    userId: string,
    contextId: string | undefined,
    repos: { index: number; name: string; path: string }[]
  ): Promise<IMResponse> {
    // DEBUG: 打印 repos 内容
    console.log(
      '[DEBUG] createRepoSelection repos:',
      repos.map(r => ({ index: r.index, name: r.name, path: r.path }))
    );

    const projectPath = this.resolveProjectPath(userId, contextId);
    const session = await this.getOrCreateSession(userId, contextId, projectPath);

    // 检查是否已有待处理的交互
    if (session.pendingInteractions.size > 0) {
      return {
        success: false,
        message: '当前有待处理的选择，请先完成后再试',
        card: this.createStatusCard('仓库选择', '当前有待处理的选择，请先完成后再试', false),
      };
    }

    // 使用 Promise 等待用户选择（不立即 resolve）
    const currentRepo = this.getConversationRepo(userId, contextId);
    const listCard: IMResponse = {
      success: true,
      message: '请选择仓库',
      card: {
        title: '📦 选择仓库',
        elements: [
          ...(currentRepo
            ? [
                {
                  type: 'markdown' as const,
                  content: `📂 当前仓库：**${currentRepo.name}**\n`,
                },
                {
                  type: 'hr' as const,
                },
              ]
            : []),
          {
            type: 'markdown' as const,
            content: '请回复序号选择仓库：',
          },
          {
            type: 'markdown' as const,
            content: repos.map((r, idx) => `${idx + 1}. ${r.name}`).join('\n'),
          },
          {
            type: 'markdown' as const,
            content: '\n💡 直接回复序号或仓库名称即可',
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
            message: '已取消',
            card: this.createStatusCard('仓库选择', '已取消', false),
          }),
        timestamp: Date.now(),
        data: {
          title: '选择仓库',
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
    for (const session of this.sessions.values()) {
      if (session.id === sessionId) {
        return session;
      }
    }
    return undefined;
  }

  async resetSession(userId: string, contextId: string | undefined): Promise<IMResponse> {
    const projectPath = this.resolveProjectPath(userId, contextId);
    const sessionKey = this.buildSessionKey(userId, contextId, projectPath);
    const session = this.sessions.get(sessionKey);

    if (!session) {
      return {
        success: true,
        message: '🔄 会话重置完成（无活跃会话）',
        card: this.createStatusCard('重置会话', '会话重置完成（无活跃会话）'),
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

    logger.info({ userId, contextId, repoName, wasRunning, pid }, 'Session reset complete');

    const elements: { type: 'markdown'; content: string }[] = [
      {
        type: 'markdown',
        content: `✅ **会话已完全重置**`,
      },
      {
        type: 'markdown',
        content: `📁 **项目：** \`${repoName}\``,
      },
    ];

    if (wasRunning && pid) {
      elements.push({
        type: 'markdown',
        content: `🤖 **Agent：** 已终止 (PID: \`${pid}\`)`,
      });
    }

    if (pendingCount > 0) {
      elements.push({
        type: 'markdown',
        content: `🔓 **清理交互：** ${pendingCount} 个待处理请求已取消`,
      });
    }

    if (queueCount > 0) {
      elements.push({
        type: 'markdown',
        content: `📬 **清空队列：** ${queueCount} 个待执行任务`,
      });
    }

    elements.push({
      type: 'markdown',
      content: `\n💡 下次发送消息时将自动创建新的会话`,
    });

    return {
      success: true,
      message: `✅ 会话重置完成：${repoName}。Agent 已终止，${queueCount} 个任务已清理，${pendingCount} 个交互已取消。`,
      card: {
        title: `🔄 重置会话 - ${repoName}`,
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
        message: '当前没有活跃的会话',
        card: this.createStatusCard('会话状态', '当前没有活跃的会话'),
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
    const statusText = running ? '运行中' : '已停止';
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
        content: `**📁 项目：** \`${repoName}\`\n**📂 路径：** \`${session.projectPath}\``,
      },
      {
        type: 'markdown' as const,
        content: `**⚙️ Executor：** \`${this.executor}\``,
      },
      {
        type: 'markdown' as const,
        content: `**🤖 Agent：** ${statusIcon} ${statusText}${pid ? ` | PID: \`${pid}\`` : ''}`,
      },
      {
        type: 'markdown' as const,
        content: `**🧭 会话状态：** \`${session.state}\` | **⏳ 待确认交互：** ${waitingCount}`,
      },
    ];

    if (planStatus && planStatus.entries.length > 0) {
      const currentStep = planStatus.current?.content
        ? `\n**🧩 当前步骤：** ${planStatus.current.content.substring(0, 100)}${planStatus.current.content.length > 100 ? '...' : ''}`
        : '';
      elements.push({
        type: 'markdown' as const,
        content: `**🗺️ Agent 计划：** ${planStatus.summary}${currentStep}`,
      });
    } else {
      elements.push({
        type: 'markdown' as const,
        content: '**🗺️ Agent 计划：** 暂无计划信息',
      });
    }

    // 当前任务
    if (session.queue.current) {
      elements.push({
        type: 'markdown' as const,
        content: `**📋 当前任务：**\n\`\`\`\n${session.queue.current.content.substring(0, 100)}${session.queue.current.content.length > 100 ? '...' : ''}\n\`\`\`\n🆔 \`${session.queue.current.id.substring(0, 8)}...\``,
      });
    } else {
      elements.push({
        type: 'markdown' as const,
        content: `**📋 当前任务：** 🕐 空闲`,
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
          ? `**📬 待执行队列 (${session.queue.pending.length} 个)：**\n${queueList}`
          : '**📬 待执行队列 (0 个)：**\n1. `(空)`',
    });

    const card: UniversalCard = {
      title: `📊 会话状态 - ${repoName}`,
      elements: elements,
    };

    // 构建文本消息（兼容非卡片客户端）
    let messageText = `📁 项目: ${repoName}\n`;
    messageText += `📂 路径: ${session.projectPath}\n`;
    messageText += `⚙️ Executor: ${this.executor}\n`;
    messageText += `🤖 Agent: ${statusText}${pid ? ` (PID: ${pid})` : ''}\n`;
    messageText += `🧭 会话状态: ${session.state} | ⏳ 待确认交互: ${waitingCount}\n`;
    if (planStatus && planStatus.entries.length > 0) {
      messageText += `🗺️ Agent 计划: ${planStatus.summary}\n`;
      if (planStatus.current?.content) {
        messageText += `🧩 当前步骤: ${planStatus.current.content.substring(0, 50)}${planStatus.current.content.length > 50 ? '...' : ''}\n`;
      }
    } else {
      messageText += '🗺️ Agent 计划: 暂无计划信息\n';
    }
    if (session.queue.current) {
      messageText += `📋 当前任务: ${session.queue.current.content.substring(0, 50)}...\n`;
    } else {
      messageText += `📋 当前任务: 空闲\n`;
    }
    messageText += `📬 待执行队列: ${session.queue.pending.length} 个任务`;

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
        message: '当前没有活跃的会话',
        card: this.createStatusCard('停止任务', '当前没有活跃的会话', false),
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
        ? `✅ 已停止当前任务，并清空队列中的 ${queueCount} 个待执行任务`
        : `✅ 已清空队列中的 ${queueCount} 个待执行任务`;

      return {
        success: true,
        message,
        card: {
          title: `🛑 停止任务 - ${repoName}`,
          elements: [
            {
              type: 'markdown',
              content: message,
            },
            {
              type: 'markdown',
              content: `📬 当前队列状态：**空闲**`,
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
          message: `✅ 已移除任务: ${removedTask.content.substring(0, 50)}...`,
          card: {
            title: `🗑️ 移除任务 - ${repoName}`,
            elements: [
              {
                type: 'markdown',
                content: `✅ 已成功移除队列中的任务\n\`\`\`\n${removedTask.content.substring(0, 100)}${removedTask.content.length > 100 ? '...' : ''}\n\`\`\``,
              },
              {
                type: 'markdown',
                content: `🆔 任务ID: \`${taskId.substring(0, 8)}...\`\n📬 剩余任务: **${session.queue.pending.length}**`,
              },
            ],
          },
        };
      }
      return {
        success: false,
        message: `❌ 未找到任务: ${taskId}`,
        card: this.createStatusCard('移除任务', `未找到任务: ${taskId.substring(0, 8)}...`, false),
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
        message: `✅ 已停止当前任务`,
        card: {
          title: `🛑 停止任务 - ${repoName}`,
          elements: [
            {
              type: 'markdown',
              content: `✅ 已成功停止当前任务`,
            },
            {
              type: 'markdown',
              content: `📋 已停止: \`${stoppedTask.content.substring(0, 50)}...\`\n📬 剩余队列: **${session.queue.pending.length}**`,
            },
          ],
        },
      };
    }

    return {
      success: true,
      message: '🕐 没有正在运行的任务',
      card: this.createStatusCard('停止任务', '没有正在运行的任务'),
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
        message: '当前已有待处理的权限请求，请先处理完当前请求再试',
        card: this.createStatusCard(
          '模式切换',
          '当前已有待处理的权限请求，请先处理完当前请求再试',
          false
        ),
      };
    }

    const state = session.acpClient?.getModeState();

    if (!state || state.availableModes.length === 0) {
      return {
        success: false,
        message: '当前 Agent 不支持模式切换',
        card: this.createStatusCard('模式切换', '当前 Agent 不支持模式切换', false),
      };
    }

    // 构建一个模拟的权限请求来复用选择逻辑
    const fakeReq: RequestPermissionRequest = {
      sessionId: session.id,
      toolCall: {
        title: `切换模式 (当前: ${state.currentModeId || '未知'})`,
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
                    title: '🎨 模式切换成功',
                    elements: [
                      {
                        type: 'markdown',
                        content: `✅ **模式已切换为：** \`${optionId}\``,
                      },
                    ],
                  }
                : this.createStatusCard('模式切换', res.message, false),
            });
          }
        },
        reject: () =>
          resolve({
            success: false,
            message: '已取消',
            card: this.createStatusCard('模式选择', '已取消', false),
          }),
        timestamp: Date.now(),
        data: {
          title: fakeReq.toolCall.title ?? '选择',
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
        message: '当前已有待处理的权限请求，请先处理完当前请求再试',
        card: this.createStatusCard(
          '模型切换',
          '当前已有待处理的权限请求，请先处理完当前请求再试',
          false
        ),
      };
    }

    const state = session.acpClient?.getModelState();

    if (!state || state.availableModels.length === 0) {
      return {
        success: false,
        message: '当前 Agent 不支持模型切换',
        card: this.createStatusCard('模型切换', '当前 Agent 不支持模型切换', false),
      };
    }

    // 构建一个模拟的权限请求来复用选择逻辑
    const fakeReq: RequestPermissionRequest = {
      sessionId: session.id,
      toolCall: {
        title: `切换模型 (当前: ${state.currentModelId || '未知'})`,
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
                    title: '🤖 模型切换成功',
                    elements: [
                      {
                        type: 'markdown',
                        content: `✅ **模型已切换为：** \`${optionId}\``,
                      },
                    ],
                  }
                : this.createStatusCard('模型切换', res.message, false),
            });
          }
        },
        reject: () =>
          resolve({
            success: false,
            message: '已取消',
            card: this.createStatusCard('模型选择', '已取消', false),
          }),
        timestamp: Date.now(),
        data: {
          title: fakeReq.toolCall.title ?? '选择',
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
