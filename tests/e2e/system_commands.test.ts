import { describe, it, beforeEach, expect } from 'bun:test';
import { SessionManager } from '../../src/core/session';
import { TaskQueueEngine } from '../../src/core/queue';
import { CommandDispatcher } from '../../src/core/dispatcher';
import type { IMMessage, IMResponse, Session } from '../../src/types';

function expectTitleContainsAny(title: string | undefined, candidates: string[]) {
  expect(title).toBeDefined();
  const t = title ?? '';
  expect(candidates.some(c => t.includes(c))).toBe(true);
}

describe('E2E System Commands', () => {
  let sessionManager: SessionManager;
  let queueEngine: TaskQueueEngine;
  let dispatcher: CommandDispatcher;
  let capturedResponses: IMResponse[];
  const testProjectPath = process.cwd();

  beforeEach(() => {
    capturedResponses = [];
    sessionManager = new SessionManager();
    sessionManager.setCurrentRepo({ name: 'test', path: testProjectPath, gitPath: '' });

    queueEngine = new TaskQueueEngine(async (sess: Session, resp: IMResponse) => {
      capturedResponses.push(resp);
    });
    dispatcher = new CommandDispatcher(sessionManager, queueEngine);
  });

  it('/current should return status with card', async () => {
    const msg = {
      userId: 'test-user',
      userName: 'Tester',
      text: 'Hello',
      timestamp: Date.now(),
      contextId: 'test-context',
    } as IMMessage;

    await dispatcher.dispatch(msg);
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await dispatcher.dispatch({
      userId: 'test-user',
      userName: 'Tester',
      text: '/current',
      timestamp: Date.now(),
      contextId: 'test-context',
    } as IMMessage);

    expect(response.success).toBe(true);
    expect(response.card).toBeDefined();
    expectTitleContainsAny(response.card?.title, ['会话状态', 'Session Status']);
  });

  it('/stop should return card', async () => {
    const msg = {
      userId: 'stop-user',
      userName: 'Tester',
      text: 'Running task',
      timestamp: Date.now(),
      contextId: 'stop-context',
    } as IMMessage;

    await dispatcher.dispatch(msg);
    await new Promise(resolve => setTimeout(resolve, 50));

    const response = await dispatcher.dispatch({
      userId: 'stop-user',
      userName: 'Tester',
      text: '/stop',
      timestamp: Date.now(),
      contextId: 'stop-context',
    } as IMMessage);

    expect(response.success).toBe(true);
    expect(response.card).toBeDefined();
    expectTitleContainsAny(response.card?.title, ['停止任务', 'Stop Task']);
  });

  it('/stop all should clear queue', async () => {
    await dispatcher.dispatch({
      userId: 'stop-all-user',
      userName: 'Tester',
      text: 'Task 1',
      timestamp: Date.now(),
      contextId: 'stop-all-context',
    } as IMMessage);

    await dispatcher.dispatch({
      userId: 'stop-all-user',
      userName: 'Tester',
      text: 'Task 2',
      timestamp: Date.now(),
      contextId: 'stop-all-context',
    } as IMMessage);

    await new Promise(resolve => setTimeout(resolve, 150));

    const response = await dispatcher.dispatch({
      userId: 'stop-all-user',
      userName: 'Tester',
      text: '/stop all',
      timestamp: Date.now(),
      contextId: 'stop-all-context',
    } as IMMessage);

    expect(response.success).toBe(true);
    expect(response.card).toBeDefined();

    const session = sessionManager.getSession('stop-all-user', 'stop-all-context', testProjectPath);
    expect(session?.queue.pending.length).toBe(0);
  });

  it('/reset should remove session', async () => {
    await dispatcher.dispatch({
      userId: 'reset-user',
      userName: 'Tester',
      text: 'Hello',
      timestamp: Date.now(),
      contextId: 'reset-context',
    } as IMMessage);

    await new Promise(resolve => setTimeout(resolve, 100));

    const sessionBefore = sessionManager.getSession('reset-user', 'reset-context', testProjectPath);
    expect(sessionBefore).toBeDefined();

    const response = await dispatcher.dispatch({
      userId: 'reset-user',
      userName: 'Tester',
      text: '/reset',
      timestamp: Date.now(),
      contextId: 'reset-context',
    } as IMMessage);

    expect(response.success).toBe(true);
    expect(response.card).toBeDefined();
    expectTitleContainsAny(response.card?.title, ['重置会话', 'Reset Session']);

    const sessionAfter = sessionManager.getSession('reset-user', 'reset-context', testProjectPath);
    expect(sessionAfter).toBeUndefined();
  });

  it('/help should return card', async () => {
    const response = await dispatcher.dispatch({
      userId: 'help-user',
      userName: 'Tester',
      text: '/help',
      timestamp: Date.now(),
    } as IMMessage);

    expect(response.success).toBe(true);
    expect(response.card).toBeDefined();
    expectTitleContainsAny(response.card?.title, ['指令帮助', 'Command Help']);
  });

  it('all responses should have card property', async () => {
    const commands = ['/current', '/help'];

    for (const cmd of commands) {
      const response = await dispatcher.dispatch({
        userId: `card-test-${cmd}`,
        userName: 'Tester',
        text: cmd,
        timestamp: Date.now(),
        contextId: `card-test-context-${cmd}`,
      } as IMMessage);
      expect(response.card).toBeDefined();
    }
  });

  it('new session after reset', async () => {
    const userId = 'reconnect-user';
    const contextId = 'reconnect-context';

    await dispatcher.dispatch({
      userId,
      userName: 'Tester',
      text: 'First',
      timestamp: Date.now(),
      contextId,
    } as IMMessage);

    await new Promise(resolve => setTimeout(resolve, 100));

    const session1 = sessionManager.getSession(userId, contextId, testProjectPath);
    const session1Id = session1?.id;

    await dispatcher.dispatch({
      userId,
      userName: 'Tester',
      text: '/reset',
      timestamp: Date.now(),
      contextId,
    } as IMMessage);

    expect(sessionManager.getSession(userId, contextId, testProjectPath)).toBeUndefined();

    await dispatcher.dispatch({
      userId,
      userName: 'Tester',
      text: 'Second',
      timestamp: Date.now(),
      contextId,
    } as IMMessage);

    await new Promise(resolve => setTimeout(resolve, 100));

    const session2 = sessionManager.getSession(userId, contextId, testProjectPath);
    expect(session2).toBeDefined();
    expect(session2?.id).not.toBe(session1Id);
  });
});
