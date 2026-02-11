import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { SessionManager } from '../../src/core/session';
import { TaskQueueEngine } from '../../src/core/queue';
import type { IMResponse, Session } from '../../src/types';

mock.module('../../src/acp/client', () => {
  return {
    ACPClient: class MockACPClient {
      private permissionHandler: any;
      private mockRunning = true;

      constructor(projectPath: string, permissionHandler: any) {
        this.permissionHandler = permissionHandler;
      }

      async startAgent() {
        this.mockRunning = true;
      }

      async stop() {
        this.mockRunning = false;
      }

      getAgentStatus() {
        return { pid: 12345, running: this.mockRunning };
      }

      getModeState() {
        return {
          availableModes: [{ id: 'plan', name: 'Plan Mode' }],
          currentModeId: 'plan',
        };
      }

      getModelState() {
        return {
          availableModels: [{ modelId: 'gpt-4', name: 'GPT-4' }],
          currentModelId: 'gpt-4',
        };
      }

      async sendPrompt(prompt: string) {
        return { success: true, message: `Echo: ${prompt}` };
      }

      async sendCommand(cmd: string) {
        return this.sendPrompt(cmd);
      }

      async cancelCurrentTask() {
        this.mockRunning = true;
      }

      async setMode(mode: string) {
        return { success: true, message: `Mode set to ${mode}` };
      }

      async setModel(model: string) {
        return { success: true, message: `Model set to ${model}` };
      }
    },
  };
});

describe('E2E Permission Flow', () => {
  let sessionManager: SessionManager;
  let queueEngine: TaskQueueEngine;
  let capturedResponses: IMResponse[];
  const testProjectPath = process.cwd();

  beforeEach(() => {
    capturedResponses = [];
    sessionManager = new SessionManager();
    sessionManager.setCurrentRepo({ name: 'test', path: testProjectPath, gitPath: '' });

    queueEngine = new TaskQueueEngine(async (session: Session, response: IMResponse) => {
      capturedResponses.push(response);
    });
  });

  it('should handle permission request flow', async () => {
    let permissionEvent: any = null;

    sessionManager.on('permissionRequest', event => {
      permissionEvent = event;
    });

    const session = await sessionManager.getOrCreateSession(
      'perm-user',
      'perm-context',
      testProjectPath
    );
    expect(session).toBeDefined();
    expect(session.pendingInteractions).toBeDefined();
  });

  it('should handle permission with index selection', async () => {
    const session = await sessionManager.getOrCreateSession(
      'index-user',
      'index-context',
      testProjectPath
    );

    const mockInteraction = {
      type: 'permission' as const,
      resolve: () => {},
      reject: () => {},
      timestamp: Date.now(),
      data: {
        title: 'Test',
        options: [
          { optionId: 'opt1', name: 'Option 1' },
          { optionId: 'opt2', name: 'Option 2' },
        ],
      },
    };
    session.pendingInteractions.set('test-req', mockInteraction);

    // 测试通过索引选择
    const result = sessionManager.resolveInteraction(session.id, 'test-req', '1');
    expect(result.success).toBe(true);
    expect(result.message).toContain('opt2');
  });

  it('should handle permission with optionId selection', async () => {
    const session = await sessionManager.getOrCreateSession(
      'id-user',
      'id-context',
      testProjectPath
    );

    const mockInteraction = {
      type: 'permission' as const,
      resolve: () => {},
      reject: () => {},
      timestamp: Date.now(),
      data: {
        title: 'Test',
        options: [
          { optionId: 'allow', name: 'Allow' },
          { optionId: 'deny', name: 'Deny' },
        ],
      },
    };
    session.pendingInteractions.set('test-req-2', mockInteraction);

    // 测试通过 optionId 选择
    const result = sessionManager.resolveInteraction(session.id, 'test-req-2', 'allow');
    expect(result.success).toBe(true);
    expect(result.message).toContain('allow');
  });

  it('should return error for invalid option', async () => {
    const session = await sessionManager.getOrCreateSession(
      'invalid-user',
      'invalid-context',
      testProjectPath
    );

    const mockInteraction = {
      type: 'permission' as const,
      resolve: () => {},
      reject: () => {},
      timestamp: Date.now(),
      data: {
        title: 'Test',
        options: [
          { optionId: '0', name: 'Option 0' },
          { optionId: '1', name: 'Option 1' },
        ],
      },
    };
    session.pendingInteractions.set('invalid-req', mockInteraction);

    // 测试无效选项
    const result = sessionManager.resolveInteraction(session.id, 'invalid-req', '99');
    expect(result.success).toBe(false);
    expect(result.message).toContain('无效的选项');
  });

  it('should handle session reset during permission pending', async () => {
    const session = await sessionManager.getOrCreateSession(
      'reset-user',
      'reset-context',
      testProjectPath
    );

    const mockInteraction = {
      type: 'permission' as const,
      resolve: () => {},
      reject: () => {},
      timestamp: Date.now(),
      data: {
        title: 'Test',
        options: [{ optionId: 'a', name: 'A' }],
      },
    };
    session.pendingInteractions.set('reset-req', mockInteraction);
    expect(session.pendingInteractions.size).toBe(1);

    // 重置应该清理所有 interactions
    await sessionManager.resetSession('reset-user', 'reset-context');
    expect(
      sessionManager.getSession('reset-user', 'reset-context', testProjectPath)
    ).toBeUndefined();
  });

  it('should handle non-existent session for permission resolution', async () => {
    const result = sessionManager.resolveInteraction('non-existent', 'req-id', '0');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('should handle non-existent request id', async () => {
    const session = await sessionManager.getOrCreateSession(
      'exist-user',
      'exist-context',
      testProjectPath
    );

    const result = sessionManager.resolveInteraction(session.id, 'non-existent-req', '0');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found or expired');
  });

  it('should correctly build session key with context', async () => {
    const session1 = await sessionManager.getOrCreateSession(
      'key-user',
      'context-a',
      testProjectPath
    );
    const session2 = await sessionManager.getOrCreateSession(
      'key-user',
      'context-b',
      testProjectPath
    );

    expect(session1.id).not.toBe(session2.id);
    expect(session1.userId).toBe(session2.userId);
  });

  it('should handle permission request data structure', async () => {
    const session = await sessionManager.getOrCreateSession(
      'data-user',
      'data-context',
      testProjectPath
    );

    const mockInteraction = {
      type: 'permission' as const,
      resolve: () => {},
      reject: () => {},
      timestamp: Date.now(),
      data: {
        title: 'Execute Shell Command',
        options: [
          { optionId: 'allow_once', name: 'Allow Once' },
          { optionId: 'allow_always', name: 'Allow Always' },
          { optionId: 'deny', name: 'Deny' },
        ],
        originalRequest: {
          sessionId: session.id,
          toolCall: { title: 'Execute Shell Command', toolCallId: 'shell' },
          options: [],
        },
      },
    };
    session.pendingInteractions.set('shell-req', mockInteraction);

    expect(session.pendingInteractions.size).toBe(1);
    const interaction = session.pendingInteractions.get('shell-req');
    expect(interaction?.data.options).toHaveLength(3);
  });

  it('should handle concurrent enqueue operations', async () => {
    const session = await sessionManager.getOrCreateSession(
      'concurrent-enqueue',
      'concurrent-context',
      testProjectPath
    );

    // 由于 agent 已启动，任务会立即开始执行
    // 所以 pending 队列可能是空的（任务已被取出执行）
    // 我们验证入队操作能正常进行即可
    const taskId1 = await queueEngine.enqueue(session, 'task-1', 'prompt');
    const taskId2 = await queueEngine.enqueue(session, 'task-2', 'prompt');
    const taskId3 = await queueEngine.enqueue(session, 'task-3', 'prompt');

    expect(taskId1).toBeDefined();
    expect(taskId2).toBeDefined();
    expect(taskId3).toBeDefined();
    expect(taskId1).not.toBe(taskId2);
    expect(taskId2).not.toBe(taskId3);
  });
});
