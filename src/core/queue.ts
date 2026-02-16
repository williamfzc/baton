/**
 * 任务队列引擎
 * 负责管理 SessionKey 级别 FIFO 队列，确保会话内串行、会话间并行
 * 支持会话状态机（IDLE/RUNNING/WAITING_CONFIRM/STOPPED）下的安全调度
 */
import type { Session, Task, IMResponse } from '../types';
import type { ACPPlanStatus } from '../acp/client';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';
import { randomUUID } from 'node:crypto';

const logger = createLogger('TaskQueue');

// 会话级别的锁，防止竞态条件
const sessionLocks = new Map<string, Promise<void>>();

// 简单的 UUID 生成函数
function generateUUID(): string {
  return randomUUID();
}

async function withSessionLock<T>(sessionId: string, handler: () => Promise<T>): Promise<T> {
  const existingLock = sessionLocks.get(sessionId);
  if (existingLock) {
    await existingLock;
  }

  let release: () => void;
  const newLock = new Promise<void>(resolve => {
    release = () => {
      sessionLocks.delete(sessionId);
      resolve();
    };
  });

  sessionLocks.set(sessionId, newLock);

  try {
    return await handler();
  } finally {
    release!();
  }
}

// 任务完成回调函数类型
export type TaskCompleteCallback = (session: Session, response: IMResponse) => Promise<void>;

export class TaskQueueEngine {
  private onTaskComplete?: TaskCompleteCallback;

  constructor(onTaskComplete?: TaskCompleteCallback) {
    this.onTaskComplete = onTaskComplete;
  }

  /**
   * 将任务加入队列
   * 使用锁机制确保队列操作的原子性，防止竞态条件
   */
  async enqueue(
    session: Session,
    content: string,
    type: 'prompt' | 'command' = 'prompt'
  ): Promise<IMResponse> {
    return await withSessionLock(session.id, async () => {
      // 只有空闲态才允许立即执行；WAITING_CONFIRM/STOPPED 仅入队不执行
      const shouldExecuteImmediately =
        session.state === 'IDLE' &&
        !session.isProcessing &&
        !session.queue.current &&
        session.pendingInteractions.size === 0;

      const task: Task = {
        id: generateUUID(),
        type,
        content,
        timestamp: Date.now(),
      };

      if (shouldExecuteImmediately) {
        // 立即执行
        session.queue.current = task;
        session.isProcessing = true;
        session.state = 'RUNNING';

        // 异步执行，不阻塞
        this.processTask(session, task).catch((err: Error) => logger.error(err));

        return {
          success: true,
          message: '', // 不发送任何消息，等待 agent 回复
        };
      }

      // 否则加入队列
      session.queue.pending.push(task);
      // Position includes current running task: position = items ahead + 1
      const position = session.queue.pending.length;

      const pausedHint =
        session.state === 'WAITING_CONFIRM'
          ? '（当前会话在等待确认，确认后将自动继续）'
          : session.state === 'STOPPED'
            ? '（当前会话已停止，请先 /reset 后再继续执行）'
            : '';

      return {
        success: true,
        message: [
          `会话当前忙碌，已为你排队，当前排在第 ${position} 位。${pausedHint}`,
          this.buildQueueSnapshot(session),
        ].join('\n\n'),
        data: { taskId: task.id, position, queue: this.getQueueData(session) },
      };
    });
  }

  private buildQueueSnapshot(session: Session): string {
    const current = session.queue.current
      ? `当前执行: ${this.truncate(session.queue.current.content)}`
      : '当前执行: 空闲';
    const queued = session.queue.pending
      .slice(0, 5)
      .map((task, index) => `${index + 1}. ${this.truncate(task.content)}`)
      .join('\n');
    const queuedText = queued || '1. (无)';

    return `状态: ${session.state}\n${current}\n队列(${session.queue.pending.length}):\n${queuedText}`;
  }

  private getQueueData(session: Session): { current: Task | null; pending: Task[]; state: string } {
    return {
      current: session.queue.current,
      pending: session.queue.pending,
      state: session.state,
    };
  }

  private truncate(content: string, limit: number = 60): string {
    return content.length > limit ? `${content.slice(0, limit)}...` : content;
  }

  private buildPlanPrefix(planStatus: ACPPlanStatus): string {
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

    const list = planStatus.entries
      .slice(0, 3)
      .map(
        (entry, index) =>
          `${index + 1}. ${formatStatusEmoji(entry.status)}${formatPriorityEmoji(entry.priority)} ${this.truncate(entry.content, 70)}`
      )
      .join('\n');
    const remains =
      planStatus.entries.length > 3
        ? `\n${t('core', 'planRemainingPrefix')}${planStatus.entries.length - 3}${t(
            'core',
            'planRemainingSuffix'
          )}`
        : '';

    return `${t('core', 'planProgressTitle')}\n${planStatus.summary}\n${list || t('core', 'planEmpty')}${remains}`;
  }

  private attachPlanProgressPrefix(session: Session, response: IMResponse): IMResponse {
    if (!response.success || !response.message || !session.acpClient) {
      return response;
    }

    if (typeof session.acpClient.getPlanStatus !== 'function') {
      return response;
    }

    const planStatus = session.acpClient.getPlanStatus();
    if (!planStatus || planStatus.entries.length === 0) {
      return response;
    }

    const planPrefix = this.buildPlanPrefix(planStatus);
    if (response.message.startsWith(planPrefix)) {
      return response;
    }

    return {
      ...response,
      message: `${planPrefix}\n\n${response.message}`,
    };
  }

  /**
   * 处理单个任务
   * 负责调用 ACP client 并发送结果
   */
  private async processTask(session: Session, task: Task): Promise<void> {
    logger.info({ taskId: task.id, content: task.content.substring(0, 50) }, 'Processing task');
    session.state = 'RUNNING';

    if (!session.acpClient) {
      logger.error({ taskId: task.id }, 'ACP client not initialized');
      if (this.onTaskComplete) {
        await this.onTaskComplete(session, {
          success: false,
          message: t('core', 'acpNotInitialized'),
        });
      }
      // 注意：不在此处调用 processNext，由 finally 块统一处理
      return;
    }

    try {
      let response: IMResponse;

      if (task.type === 'prompt') {
        // 调用 ACP 发送 prompt
        response = await session.acpClient.sendPrompt(task.content);
        logger.info({ taskId: task.id }, 'Task completed');
      } else {
        // 命令类型直接透传给 agent
        response = await session.acpClient.sendCommand(task.content);
        logger.info({ taskId: task.id }, 'Command completed');
      }

      response = this.attachPlanProgressPrefix(session, response);

      // 发送结果给用户
      if (this.onTaskComplete) {
        await this.onTaskComplete(session, response);
      }
    } catch (error) {
      logger.error({ taskId: task.id, error }, 'Task failed');
      if (this.onTaskComplete) {
        await this.onTaskComplete(session, {
          success: false,
          message: `${t('core', 'taskFailedPrefix')}${
            error instanceof Error ? error.message : t('core', 'unknownError')
          }`,
        });
      }
    } finally {
      // 任务完成，处理下一个
      // 这是唯一调用 processNext 的地方，确保不会重复调用
      await this.processNext(session);
    }
  }

  /**
   * 处理队列中的下一个任务
   * 注意：此方法仅在 processTask 的 finally 块中调用，确保串行执行
   */
  private async processNext(session: Session): Promise<void> {
    const nextTask = await withSessionLock(session.id, async () => {
      if (session.state === 'WAITING_CONFIRM' || session.state === 'STOPPED') {
        logger.info(
          { sessionId: session.id, state: session.state },
          'Session paused, skip scheduling'
        );
        return null;
      }

      if (session.queue.pending.length > 0) {
        const task = session.queue.pending.shift()!;
        session.queue.current = task;
        session.isProcessing = true;
        session.state = 'RUNNING';
        return task;
      }

      session.queue.current = null;
      session.isProcessing = false;
      session.state = 'IDLE';
      logger.info('No more tasks in queue');
      return null;
    });

    if (!nextTask) {
      return;
    }

    logger.info({ taskId: nextTask.id }, 'Starting next task');
    this.processTask(session, nextTask).catch((err: Error) => logger.error(err));
  }
}
