import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { SessionManager } from '../../src/core/session';
import { TaskQueueEngine } from '../../src/core/queue';
import { CommandDispatcher } from '../../src/core/dispatcher';
import type { IMMessage, IMResponse, Session } from '../../src/types';

// Mock ACPClient
const mockSendPrompt = mock(async (prompt: string) => ({ success: true, message: `Echo: ${prompt}` }));

mock.module('../../src/acp/client', () => {
  return {
    ACPClient: class MockACPClient {
      private permissionHandler: any;
      constructor(projectPath: string, permissionHandler: any) {
        this.permissionHandler = permissionHandler;
      }
      async startAgent() {}
      async stop() {}
      async sendPrompt(prompt: string) {
        if (prompt.includes('trigger_permission')) {
          const optionId = await this.permissionHandler({
            toolCall: { title: 'Test Tool' },
            options: [
              { optionId: 'allow', name: 'Allow' },
              { optionId: 'deny', name: 'Deny' }
            ]
          });
          return { success: true, message: `Permission result: ${optionId}` };
        }
        return { success: true, message: `Echo: ${prompt}` };
      }
      async sendCommand(cmd: string) { return this.sendPrompt(cmd); }
      async cancelCurrentTask() {}
    }
  };
});

describe('E2E Permission Flow', () => {
  let sessionManager: SessionManager;
  let queueEngine: TaskQueueEngine;
  let dispatcher: CommandDispatcher;
  const testProjectPath = process.cwd();

  beforeEach(() => {
    sessionManager = new SessionManager(testProjectPath);
  });

  it('should complete a full permission flow', async () => {
    let capturedResponse: IMResponse | null = null;
    let permissionEvent: any = null;

    queueEngine = new TaskQueueEngine(async (session: Session, response: IMResponse) => {
      capturedResponse = response;
    });

    dispatcher = new CommandDispatcher(sessionManager, queueEngine);

    sessionManager.on('permissionRequest', (event) => {
      permissionEvent = event;
    });

    const message: IMMessage = {
      userId: 'test-user',
      userName: 'Tester',
      text: 'please trigger_permission',
      timestamp: Date.now()
    };

    await dispatcher.dispatch(message);
    
    // Wait for the permission event
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(permissionEvent).toBeDefined();
    expect(permissionEvent.request.toolCall.title).toBe('Test Tool');
    
    const { sessionId, requestId } = permissionEvent;

    // Simulate user selecting an option via /select command
    const selectMessage: IMMessage = {
      userId: 'test-user',
      userName: 'Tester',
      text: `/select ${requestId} allow`,
      timestamp: Date.now()
    };

    const selectResponse = await dispatcher.dispatch(selectMessage);
    expect(selectResponse.success).toBe(true);
    expect(selectResponse.message).toContain('allow');

    // Wait for the task to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(capturedResponse).toBeDefined();
    expect(capturedResponse!.message).toContain('Permission result: allow');
  });

  it('should handle index-based selection', async () => {
    let permissionEvent: any = null;
    queueEngine = new TaskQueueEngine(async () => {});
    dispatcher = new CommandDispatcher(sessionManager, queueEngine);
    sessionManager.on('permissionRequest', (event) => { permissionEvent = event; });

    await dispatcher.dispatch({
      userId: 'user2',
      userName: 'Tester2',
      text: 'trigger_permission',
      timestamp: Date.now()
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    const { requestId } = permissionEvent;

    // Select index 1 (Deny)
    const selectMessage: IMMessage = {
      userId: 'user2',
      userName: 'Tester2',
      text: `/select ${requestId} 1`,
      timestamp: Date.now()
    };

        const selectResponse = await dispatcher.dispatch(selectMessage);

        expect(selectResponse.success).toBe(true);

        expect(selectResponse.message).toContain('deny');

      });

    

      it('should timeout and auto-reject permission request', async () => {

        // 1. Create session manager with very short timeout (0.1s)

        const shortSessionManager = new SessionManager(testProjectPath, 0.1);

        const shortQueueEngine = new TaskQueueEngine(async () => {});

        const shortDispatcher = new CommandDispatcher(shortSessionManager, shortQueueEngine);

    

        let permissionEvent: any = null;

        shortSessionManager.on('permissionRequest', (event) => {

          permissionEvent = event;

        });

    

        // 2. Trigger permission request

        await shortDispatcher.dispatch({

          userId: 'timeout-user',

          userName: 'TimeoutTester',

          text: 'trigger_permission',

          timestamp: Date.now()

        });

    

        // 3. Wait for event

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(permissionEvent).toBeDefined();

        const { requestId } = permissionEvent;

    

        // 4. Wait for timeout (longer than 0.1s)

        await new Promise(resolve => setTimeout(resolve, 150));

    

        // 5. Try to resolve it now, should fail because it already timed out

        const selectResponse = await shortDispatcher.dispatch({

          userId: 'timeout-user',

          userName: 'TimeoutTester',

          text: `/select ${requestId} allow`,

          timestamp: Date.now()

        });

    

                    expect(selectResponse.success).toBe(false);

    

                    expect(selectResponse.message).toContain('not found or expired');

    

                  });

    

                

    

                  it('should implicitly cancel pending permission when new prompt arrives', async () => {

    

                    let capturedResponses: string[] = [];

    

                    queueEngine = new TaskQueueEngine(async (s, r) => {

    

                      capturedResponses.push(r.message);

    

                    });

    

                    dispatcher = new CommandDispatcher(sessionManager, queueEngine);

    

                

    

                    // 1. Trigger first task with permission

    

                    await dispatcher.dispatch({

    

                      userId: 'preempt-user',

    

                      userName: 'PreemptTester',

    

                      text: 'trigger_permission',

    

                      timestamp: Date.now()

    

                    });

    

                

    

                    await new Promise(resolve => setTimeout(resolve, 50));

    

                    

    

                    // 2. Send a new prompt immediately (implicit cancellation)

    

                    await dispatcher.dispatch({

    

                      userId: 'preempt-user',

    

                      userName: 'PreemptTester',

    

                      text: 'new instruction',

    

                      timestamp: Date.now()

    

                    });

    

                

    

                    await new Promise(resolve => setTimeout(resolve, 100));

    

                

    

                    // The first task should have been cancelled or finished with fallback

    

                    // The second task should have finished

    

                    expect(capturedResponses.length).toBeGreaterThanOrEqual(1);

    

                    expect(capturedResponses.some(m => m.includes('new instruction'))).toBe(true);

    

                  });

    

                });

    

                

    

            

    

        

    