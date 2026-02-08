import type { Session, Task, IMResponse } from '../types';
import { ACPClient } from '../acp/client';

// 简单的 UUID 生成函数
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 内存存储，进程重启即重置
const sessions = new Map<string, Session>();

export class SessionManager {
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  async getOrCreateSession(userId: string): Promise<Session> {
    const sessionKey = `${userId}:${this.projectPath}`;
    
    if (!sessions.has(sessionKey)) {
      const session: Session = {
        id: generateUUID(),
        userId,
        projectPath: this.projectPath,
        acpClient: null,
        queue: {
          pending: [],
          current: null
        },
        isProcessing: false
      };
      sessions.set(sessionKey, session);
      console.log(`[Session] Created new session for user ${userId}`);
    }

    const session = sessions.get(sessionKey)!;
    
    // 确保 agent 进程已启动
    if (!session.acpClient) {
      console.log(`[Session] Starting agent for session ${session.id}`);
      const acpClient = new ACPClient(this.projectPath);
      await acpClient.startAgent();
      session.acpClient = acpClient;
    }

    return session;
  }

  getSession(userId: string): Session | undefined {
    const sessionKey = `${userId}:${this.projectPath}`;
    return sessions.get(sessionKey);
  }

  async resetSession(userId: string): Promise<IMResponse> {
    const sessionKey = `${userId}:${this.projectPath}`;
    const session = sessions.get(sessionKey);
    
    if (session?.acpClient) {
      await session.acpClient.stop();
    }
    
    sessions.delete(sessionKey);
    
    return {
      success: true,
      message: 'Session reset successfully. All context cleared.'
    };
  }

  getQueueStatus(userId: string): IMResponse {
    const session = this.getSession(userId);
    if (!session) {
      return {
        success: true,
        message: 'No active session.'
      };
    }

    const queueInfo = {
      current: session.queue.current,
      pending: session.queue.pending,
      pendingCount: session.queue.pending.length,
      isProcessing: session.isProcessing
    };

    return {
      success: true,
      message: `Queue status: ${queueInfo.pendingCount} pending, ${session.isProcessing ? 'processing' : 'idle'}`,
      data: queueInfo
    };
  }

  async stopTask(userId: string, taskId?: string): Promise<IMResponse> {
    const session = this.getSession(userId);
    if (!session) {
      return {
        success: false,
        message: 'No active session.'
      };
    }

    if (taskId === 'all') {
      // 停止当前任务并清空队列
      if (session.queue.current && session.acpClient) {
        await session.acpClient.cancelCurrentTask();
      }
      session.queue.pending = [];
      session.queue.current = null;
      session.isProcessing = false;
      
      return {
        success: true,
        message: 'All tasks stopped and queue cleared.'
      };
    }

    if (taskId) {
      // 移除指定任务
      const index = session.queue.pending.findIndex(t => t.id === taskId);
      if (index > -1) {
        session.queue.pending.splice(index, 1);
        return {
          success: true,
          message: `Task ${taskId} removed from queue.`
        };
      }
      return {
        success: false,
        message: `Task ${taskId} not found in queue.`
      };
    }

    // 默认停止当前任务
    if (session.queue.current && session.acpClient) {
      await session.acpClient.cancelCurrentTask();
      session.queue.current = null;
      session.isProcessing = false;
      
      return {
        success: true,
        message: 'Current task stopped.'
      };
    }

    return {
      success: true,
      message: 'No running task to stop.'
    };
  }
}