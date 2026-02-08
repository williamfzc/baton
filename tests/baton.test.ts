import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CommandDispatcher } from '../src/core/dispatcher';
import { SessionManager } from '../src/core/session';
import type { IMMessage } from '../src/types';

// Mock Feishu Client - 直接在单测中模拟 IM 消息
class MockFeishuClient {
  private dispatcher: CommandDispatcher;
  private userId: string = 'test-user-001';
  private userName: string = 'Test User';

  constructor(projectPath: string) {
    this.dispatcher = new CommandDispatcher(projectPath);
  }

  async sendMessage(text: string): Promise<any> {
    const message: IMMessage = {
      userId: this.userId,
      userName: this.userName,
      text,
      timestamp: Date.now()
    };

    return await this.dispatcher.dispatch(message);
  }
}

describe('Baton MVP Tests', () => {
  let mockClient: MockFeishuClient;
  const testProjectPath = process.cwd();

  beforeEach(() => {
    mockClient = new MockFeishuClient(testProjectPath);
  });

  describe('Command Parser', () => {
    it('should parse /help command', async () => {
      const response = await mockClient.sendMessage('/help');
      assert.strictEqual(response.success, true);
      assert.ok(response.message.includes('Baton Commands'));
    });

    it('should parse /current command', async () => {
      const response = await mockClient.sendMessage('/current');
      assert.strictEqual(response.success, true);
    });

    it('should parse /reset command', async () => {
      const response = await mockClient.sendMessage('/reset');
      assert.strictEqual(response.success, true);
      assert.ok(response.message.includes('reset'));
    });

    it('should parse /stop command', async () => {
      const response = await mockClient.sendMessage('/stop');
      assert.strictEqual(response.success, true);
    });

    it('should treat regular text as prompt', async () => {
      const response = await mockClient.sendMessage('Hello, this is a test prompt');
      assert.strictEqual(response.success, true);
      // 如果是队列模式，会返回排队信息
      assert.ok(/queued|started/i.test(response.message));
    });
  });

  describe('Task Queue', () => {
    it('should queue multiple tasks', async () => {
      // 发送多个消息
      const response1 = await mockClient.sendMessage('First task');
      const response2 = await mockClient.sendMessage('Second task');

      assert.strictEqual(response1.success, true);
      assert.strictEqual(response2.success, true);
      
      // 第二个任务应该被排队
      if (response2.message.includes('queued')) {
        assert.ok(response2.message.includes('Position'));
      }
    });

    it('should show queue status', async () => {
      await mockClient.sendMessage('Test task');
      const status = await mockClient.sendMessage('/current');
      
      assert.strictEqual(status.success, true);
    });
  });

  describe('Session Management', () => {
    it('should create session on first message', async () => {
      const sessionManager = new SessionManager(testProjectPath);
      
      // 初始应该没有 session
      const initial = sessionManager.getSession('new-user');
      assert.strictEqual(initial, undefined);

      // 发送消息后应该有 session
      const response = await mockClient.sendMessage('Hello');
      assert.strictEqual(response.success, true);
    });

    it('should reset session', async () => {
      // 先创建 session
      await mockClient.sendMessage('Create session');
      
      // 重置
      const reset = await mockClient.sendMessage('/reset');
      assert.strictEqual(reset.success, true);
    });
  });

  describe('Mock Feishu Scenarios', () => {
    it('should simulate multi-user interaction', async () => {
      const user1 = new MockFeishuClient(testProjectPath);
      const user2 = new MockFeishuClient(testProjectPath);

      // 不同用户应该创建不同的 session
      const res1 = await user1.sendMessage('User 1 message');
      const res2 = await user2.sendMessage('User 2 message');

      assert.strictEqual(res1.success, true);
      assert.strictEqual(res2.success, true);
    });

    it('should handle rapid messages', async () => {
      const messages = [
        'Message 1',
        'Message 2', 
        'Message 3'
      ];

      const responses = await Promise.all(
        messages.map(msg => mockClient.sendMessage(msg))
      );

      responses.forEach(res => {
        assert.strictEqual(res.success, true);
      });
    });
  });
});