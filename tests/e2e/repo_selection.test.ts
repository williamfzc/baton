import { describe, it, beforeEach, expect } from 'bun:test';
import { SessionManager } from '../../src/core/session';
import type { IMResponse } from '../../src/types';

describe('E2E Repo Selection Flow', () => {
  let sessionManager: SessionManager;
  const testProjectPath = process.cwd();

  beforeEach(() => {
    sessionManager = new SessionManager(testProjectPath);
  });

  it('should create repo selection interaction', async () => {
    const mockRepos = [
      { index: 0, name: 'repo-a', path: '.' },
      { index: 1, name: 'repo-b', path: '../repo-b' },
    ];

    // 创建仓库选择
    const selectionPromise = sessionManager.createRepoSelection(
      'test-user',
      'test-context',
      mockRepos
    );

    // 等待交互创建
    await new Promise(resolve => setTimeout(resolve, 300));

    const session = sessionManager.getSession('test-user', 'test-context');
    expect(session).toBeDefined();
    expect(session!.pendingInteractions.size).toBe(1);

    const interaction = Array.from(session!.pendingInteractions.values())[0];
    expect(interaction.type).toBe('repo_selection');
    expect(interaction.data.options).toHaveLength(2);
    expect(interaction.data.title).toBe('选择仓库');

    // 获取 requestId 并 resolve
    const requestId = Array.from(session!.pendingInteractions.keys())[0];
    const result = await sessionManager.resolveInteraction(session!.id, requestId, '1');
    expect(result.success).toBe(true);

    // 等待选择完成
    const finalResult = await selectionPromise;
    expect(finalResult.success).toBe(true);
  });

  it('should handle multiple options', async () => {
    const mockRepos = [
      { index: 0, name: 'frontend', path: './frontend' },
      { index: 1, name: 'backend', path: './backend' },
      { index: 2, name: 'shared', path: './shared' },
      { index: 3, name: 'docs', path: './docs' },
      { index: 4, name: 'scripts', path: './scripts' },
    ];

    sessionManager.createRepoSelection('test-user-2', undefined, mockRepos);

    await new Promise(resolve => setTimeout(resolve, 300));

    const session = sessionManager.getSession('test-user-2');
    const interaction = Array.from(session!.pendingInteractions.values())[0];
    expect(interaction.data.options).toHaveLength(5);
    expect(interaction.data.options[4].optionId).toBe('4');
    expect(interaction.data.options[4].name).toBe('scripts');
  });

  it('should prevent creating new selection while one is pending', async () => {
    const mockRepos = [{ index: 0, name: 'repo-a', path: '.' }];

    // 第一个选择
    sessionManager.createRepoSelection('test-user-3', undefined, mockRepos);
    await new Promise(resolve => setTimeout(resolve, 100));

    // 尝试创建第二个选择
    const secondResult = await sessionManager.createRepoSelection(
      'test-user-3',
      undefined,
      mockRepos
    );

    expect(secondResult.success).toBe(false);
    expect(secondResult.message).toContain('当前有待处理的选择');
  });

  it('should resolve interaction by optionId', async () => {
    const mockRepos = [
      { index: 0, name: 'alpha', path: './alpha' },
      { index: 1, name: 'beta', path: './beta' },
    ];

    const selectionPromise = sessionManager.createRepoSelection(
      'test-user-4',
      undefined,
      mockRepos
    );

    await new Promise(resolve => setTimeout(resolve, 300));

    const session = sessionManager.getSession('test-user-4');
    const requestId = Array.from(session!.pendingInteractions.keys())[0];

    // 使用 optionId "0"
    const result = await sessionManager.resolveInteraction(session!.id, requestId, '0');
    expect(result.success).toBe(true);

    const finalResult = await selectionPromise;
    expect(finalResult.success).toBe(true);
  });

  it('should clean up interaction after resolution', async () => {
    const mockRepos = [{ index: 0, name: 'repo-a', path: '.' }];

    const selectionPromise = sessionManager.createRepoSelection(
      'test-user-5',
      undefined,
      mockRepos
    );

    await new Promise(resolve => setTimeout(resolve, 300));

    let session = sessionManager.getSession('test-user-5');
    expect(session!.pendingInteractions.size).toBe(1);

    const requestId = Array.from(session!.pendingInteractions.keys())[0];
    await sessionManager.resolveInteraction(session!.id, requestId, '0');

    session = sessionManager.getSession('test-user-5');
    expect(session!.pendingInteractions.size).toBe(0);

    await selectionPromise;
  });

  it('should return error for invalid option index', async () => {
    const mockRepos = [
      { index: 0, name: 'repo-a', path: '.' },
      { index: 1, name: 'repo-b', path: '../repo-b' },
    ];

    sessionManager.createRepoSelection('test-user-6', undefined, mockRepos);

    await new Promise(resolve => setTimeout(resolve, 300));

    const session = sessionManager.getSession('test-user-6');
    const requestId = Array.from(session!.pendingInteractions.keys())[0];

    // 使用超出范围的索引
    const result = await sessionManager.resolveInteraction(session!.id, requestId, '10');
    expect(result.success).toBe(false);
    expect(result.message).toContain('无效的选项');
  });
});
