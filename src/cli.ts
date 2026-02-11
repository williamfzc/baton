/**
 * CLI 交互模式
 * 提供命令行交互界面，用于本地开发和测试，直接通过终端与 Agent 对话
 * 适合开发调试和无 IM 平台配置的场景
 * 支持多仓库切换
 */
import readline from 'node:readline/promises';
import * as path from 'node:path';
import { CommandDispatcher } from './core/dispatcher';
import { SessionManager } from './core/session';
import { TaskQueueEngine } from './core/queue';
import { RepoManager } from './core/repo';
import type { IMMessage, IMResponse, Session, RepoInfo } from './types';
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';

// 权限请求事件类型
interface PermissionRequestEvent {
  requestId: string;
  request: RequestPermissionRequest;
}

// 模拟 IM 消息循环
export async function main(workDir?: string) {
  const rootPath = workDir || process.cwd();

  console.log('╔════════════════════════════════════════╗');
  console.log('║           Baton CLI v0.1.0             ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\nRoot: ${rootPath}`);
  console.log('Type your message (or command), or "quit" to exit:\n');

  const mockUserId = 'local-user';
  const mockUserName = 'Developer';
  let isShuttingDown = false;

  // 扫描仓库
  const repoManager = new RepoManager();
  let repos: RepoInfo[] = [];
  try {
    repos = await repoManager.scanFromRoot(rootPath);
  } catch {
    // 扫描失败，继续
  }

  let selectedRepo: RepoInfo;
  if (repos.length === 0) {
    console.log('\n⚠️  未发现任何 Git 仓库，使用当前目录');
    selectedRepo = {
      name: path.basename(rootPath),
      path: rootPath,
      gitPath: path.join(rootPath, '.git'),
    };
  } else if (repos.length === 1) {
    selectedRepo = repos[0];
    console.log(`\n📂 当前仓库: ${selectedRepo.name}\n`);
  } else {
    console.log('\n📦 发现多个 Git 仓库:\n');
    repos.forEach((repo, idx) => {
      const relPath = repoManager.listRepos()[idx].path;
      console.log(`   ${idx}. ${repo.name} (${relPath})`);
    });
    console.log();
    selectedRepo = repos[0];
    console.log(`📂 当前仓库: ${selectedRepo.name}\n`);
  }

  // 创建会话管理器
  const sessionManager = new SessionManager();
  sessionManager.setRepoManager(repoManager);
  sessionManager.setCurrentRepo(selectedRepo);

  // 监听权限请求
  sessionManager.on('permissionRequest', (event: PermissionRequestEvent) => {
    const { requestId, request } = event;
    const toolCall = request.toolCall;
    const options = request.options;

    console.log('\n' + '🔐'.repeat(10) + ' 权限确认 ' + '🔐'.repeat(10));
    console.log(`操作：${toolCall.title}`);

    if (toolCall.rawInput) {
      const details =
        typeof toolCall.rawInput === 'string'
          ? toolCall.rawInput
          : JSON.stringify(toolCall.rawInput, null, 2);
      console.log(`细节：\n${details}`);
    }

    console.log('请选择：');
    options.forEach((opt: PermissionOption, index: number) => {
      console.log(`${index}. ${opt.name}（${opt.optionId}）`);
    });

    console.log(`\n回复数字 0..${options.length - 1} 选择。`);
    console.log(
      `如果你想改需求/发送新指令，直接输入内容即可（会自动取消本次权限确认并按新任务处理）。`
    );
    console.log(`停止任务请发送 /stop。`);
    console.log('🆔 Request ID: ' + requestId); // 保留 ID 供参考
    console.log('─'.repeat(30) + '\n');

    process.stdout.write('> '); // 恢复提示符
  });

  // 创建任务队列引擎，传入完成回调（在终端显示）
  const queueEngine = new TaskQueueEngine(async (session: Session, response: IMResponse) => {
    if (isShuttingDown) return;
    console.log('\n' + '─'.repeat(50));
    console.log('🤖 Agent 回复:');
    console.log(response.message);
    console.log('─'.repeat(50));
    console.log();
    process.stdout.write('> '); // 恢复提示符
  });

  // 创建指令分发器
  const dispatcher = new CommandDispatcher(sessionManager, queueEngine);

  // 使用 readline 读取用户输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 设置 Ctrl+C 处理
  rl.on('SIGINT', () => {
    console.log('\n👋 Goodbye!');
    isShuttingDown = true;
    rl.close();
    process.exit(0);
  });

  // 同时监听 process 的 SIGINT（某些终端 readline 捕获不到）
  process.on('SIGINT', () => {
    console.log('\n👋 Goodbye!');
    isShuttingDown = true;
    rl.close();
    process.exit(0);
  });

  try {
    while (true) {
      if (isShuttingDown) break;

      const text = (await rl.question('> ')).trim();

      if (text.toLowerCase() === 'quit' || text.toLowerCase() === 'exit') {
        console.log('\n👋 Goodbye!');
        rl.close();
        break;
      }

      if (!text) continue;

      const message: IMMessage = {
        userId: mockUserId,
        userName: mockUserName,
        text,
        timestamp: Date.now(),
      };

      try {
        const response = await dispatcher.dispatch(message);

        // 如果是系统指令，直接显示结果
        if (!text.startsWith('/') || text === '/help' || text === '/current') {
          console.log('─'.repeat(50));
          console.log('📨 Response:');
          console.log(response.message);
          if (response.data) {
            console.log('\n📊 Data:', JSON.stringify(response.data, null, 2));
          }
          console.log('─'.repeat(50));
          console.log();
        }
        // 如果是 prompt，等待回调显示结果
      } catch (error) {
        console.error('❌ Error:', error);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err: Error) => console.error(err));
