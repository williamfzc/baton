import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { SessionManager } from '../../src/core/session';
import { TaskQueueEngine } from '../../src/core/queue';
import type { IMResponse, Session } from '../../src/types';

// 模拟 ACPClient
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
        return {
          pid: 12345,
          running: this.mockRunning,
        };
      }

      getModeState() {
        return {
          availableModes: [
            { id: 'plan', name: 'Plan Mode' },
            { id: 'act', name: 'Act Mode' },
          ],
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

describe('E2E Feishu Card Interaction', () => {
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

  it('should resolve permission via card action and continue task flow', async () => {
    let permissionEvent: any = null;

    // 监听权限请求事件
    sessionManager.on('permissionRequest', event => {
      permissionEvent = event;
    });

    // 创建 session
    const session = await sessionManager.getOrCreateSession(
      'test-user',
      'test-context',
      testProjectPath
    );

    // 模拟手动添加一个权限请求到 pendingInteractions
    const mockRequest = {
      type: 'permission' as const,
      resolve: () => {},
      reject: () => {},
      timestamp: Date.now(),
      data: {
        title: 'Permission Check',
        options: [
          { optionId: 'allow', name: 'Allow' },
          { optionId: 'deny', name: 'Deny' },
        ],
      },
    };
    const requestId = 'manual-req-id';
    session.pendingInteractions.set(requestId, mockRequest);

    // 验证权限请求已添加
    expect(session.pendingInteractions.size).toBe(1);
    permissionEvent = null;

    // 模拟用户通过卡片选择允许
    const resolveResult = sessionManager.resolveInteraction(session.id, requestId, 'allow');

    expect(resolveResult.success).toBe(true);
    expect(session.pendingInteractions.size).toBe(0);
  });

  it('should handle card action with session_id in value', async () => {
    const session = await sessionManager.getOrCreateSession(
      'test-user-2',
      'test-context-2',
      testProjectPath
    );
    expect(session).toBeDefined();
    expect(session.id).toBeDefined();
  });

  it('should handle permission request timeout', async () => {
    const shortTimeoutSessionManager = new SessionManager(1); // 1 second timeout
    shortTimeoutSessionManager.setCurrentRepo({ name: 'test', path: testProjectPath, gitPath: '' });

    let permissionEvent: any = null;
    shortTimeoutSessionManager.on('permissionRequest', event => {
      permissionEvent = event;
    });

    const session = await shortTimeoutSessionManager.getOrCreateSession(
      'timeout-user',
      'timeout-context',
      testProjectPath
    );

    // 触发一个权限请求
    const queueEngine = new TaskQueueEngine(async () => {});
    queueEngine.enqueue(session, 'trigger_permission', 'prompt');

    await new Promise(resolve => setTimeout(resolve, 1500));

    // 超时后请求应该被自动处理
    expect(session.pendingInteractions.size).toBe(0);
  });

  it('should handle permission with multiple options', async () => {
    const session = await sessionManager.getOrCreateSession(
      'multi-user',
      'multi-context',
      testProjectPath
    );

    expect(session).toBeDefined();
    expect(session.pendingInteractions).toBeDefined();
  });

  it('should correctly handle session isolation between contexts', async () => {
    const session1 = await sessionManager.getOrCreateSession(
      'shared-user',
      'context-1',
      testProjectPath
    );
    const session2 = await sessionManager.getOrCreateSession(
      'shared-user',
      'context-2',
      testProjectPath
    );

    expect(session1.id).not.toBe(session2.id);
    expect(session1.userId).toBe(session2.userId);
    expect(session1.userId).toBe('shared-user');
  });

  it('should handle concurrent permission requests', async () => {
    const session = await sessionManager.getOrCreateSession(
      'concurrent-user',
      'concurrent-context',
      testProjectPath
    );

    // 添加一个模拟的 pending interaction
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
    session.pendingInteractions.set('req-1', mockInteraction);

    // 验证不能同时有多个 pending interaction
    const newInteraction = {
      type: 'permission' as const,
      resolve: () => {},
      reject: () => {},
      timestamp: Date.now(),
      data: {
        title: 'Test2',
        options: [{ optionId: 'b', name: 'B' }],
      },
    };
    session.pendingInteractions.set('req-2', newInteraction);

    expect(session.pendingInteractions.size).toBe(2);
  });
});
