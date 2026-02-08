import type { Session, Task, IMResponse } from '../types';

// 简单的 UUID 生成函数
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export class TaskQueueEngine {
  constructor() {}

  async enqueue(session: Session, content: string, type: 'prompt' | 'command' = 'prompt'): Promise<IMResponse> {
    const task: Task = {
      id: generateUUID(),
      type,
      content,
      timestamp: Date.now()
    };

    // 如果当前没有任务在执行，直接执行
    if (!session.isProcessing && !session.queue.current) {
      session.queue.current = task;
      session.isProcessing = true;
      
      // 异步执行，不阻塞
      this.processTask(session, task).catch(console.error);
      
      return {
        success: true,
        message: 'Task started immediately.'
      };
    }

    // 否则加入队列
    session.queue.pending.push(task);
    const position = session.queue.pending.length;
    
    return {
      success: true,
      message: `Task queued. Position: ${position}/${position}`,
      data: { taskId: task.id, position }
    };
  }

  private async processTask(session: Session, task: Task): Promise<void> {
    console.log(`[Queue] Processing task ${task.id}: ${task.content.substring(0, 50)}...`);
    
    if (!session.acpClient) {
      console.error(`[Queue] Task ${task.id} failed: ACP client not initialized`);
      await this.processNext(session);
      return;
    }
    
    try {
      if (task.type === 'prompt') {
        // 调用 ACP 发送 prompt
        const response = await session.acpClient.sendPrompt(task.content);
        
        console.log(`[Queue] Task ${task.id} completed.`);
        console.log(`[Response] ${response.message}`);
      } else {
        // 命令类型直接透传给 agent
        const response = await session.acpClient.sendCommand(task.content);
        
        console.log(`[Queue] Command ${task.id} completed.`);
        console.log(`[Response] ${response.message}`);
      }
    } catch (error) {
      console.error(`[Queue] Task ${task.id} failed:`, error);
    } finally {
      // 任务完成，处理下一个
      await this.processNext(session);
    }
  }

  private async processNext(session: Session): Promise<void> {
    session.queue.current = null;
    session.isProcessing = false;

    // 检查队列中是否有待处理任务
    if (session.queue.pending.length > 0) {
      const nextTask = session.queue.pending.shift()!;
      session.queue.current = nextTask;
      session.isProcessing = true;
      
      console.log(`[Queue] Starting next task ${nextTask.id}`);
      
      // 异步执行下一个任务
      this.processTask(session, nextTask).catch(console.error);
    } else {
      console.log('[Queue] No more tasks in queue.');
    }
  }
}