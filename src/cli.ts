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
import { loadConfig } from './config/loader';
import { initI18n, resolveLocale, t } from './i18n';
import type { IMMessage, IMResponse, Session, RepoInfo } from './types';
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk';

// 权限请求事件类型
interface PermissionRequestEvent {
  requestId: string;
  request: RequestPermissionRequest;
}

// 模拟 IM 消息循环
export async function main(workDir?: string, locale?: string) {
  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig();
  } catch {
    config = undefined;
  }
  initI18n({ defaultLocale: resolveLocale(locale ?? config?.language) });
  const rootPath = path.resolve(workDir || process.cwd());

  console.log(t('cli', 'banner'));
  console.log(`\n${t('cli', 'rootLabel')}${rootPath}`);
  console.log(t('cli', 'inputHint'));

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
    console.log(`\n${t('cli', 'repoNone')}`);
    selectedRepo = {
      name: path.basename(rootPath),
      path: rootPath,
      gitPath: path.join(rootPath, '.git'),
    };
  } else if (repos.length === 1) {
    selectedRepo = repos[0];
    console.log(`\n${t('cli', 'repoCurrentLabel')}${selectedRepo.name}\n`);
  } else {
    console.log(`\n${t('cli', 'repoMultipleTitle')}\n`);
    repos.forEach((repo, idx) => {
      const relPath = repoManager.listRepos()[idx].path;
      console.log(`   ${idx}. ${repo.name} (${relPath})`);
    });
    console.log();
    selectedRepo = repos[0];
    console.log(`${t('cli', 'repoCurrentLabel')}${selectedRepo.name}\n`);
  }

  // 加载配置获取 executor 与自定义 ACP 启动配置
  let executor = 'opencode';
  let acpLaunchConfig:
    | { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
    | undefined;
  try {
    const effectiveConfig = config ?? loadConfig();
    executor = (effectiveConfig.acp?.executor || process.env.BATON_EXECUTOR || 'opencode').replace(
      /_/g,
      '-'
    );
    if (effectiveConfig.acp?.command) {
      acpLaunchConfig = {
        command: effectiveConfig.acp.command,
        args: effectiveConfig.acp.args,
        cwd: effectiveConfig.acp.cwd,
        env: effectiveConfig.acp.env,
      };
    }
  } catch {
    // 配置加载失败时使用默认值
  }

  // 创建会话管理器
  const sessionManager = new SessionManager(300, executor, acpLaunchConfig);
  sessionManager.setRepoManager(repoManager);
  sessionManager.setCurrentRepo(selectedRepo);

  // 监听权限请求
  sessionManager.on('permissionRequest', (event: PermissionRequestEvent) => {
    const { requestId, request } = event;
    const toolCall = request.toolCall;
    const options = request.options;

    console.log(`\n${'🔐'.repeat(10)} ${t('cli', 'permissionTitle')} ${'🔐'.repeat(10)}`);
    console.log(`${t('cli', 'actionLabel')}${toolCall.title}`);

    if (toolCall.rawInput) {
      const details =
        typeof toolCall.rawInput === 'string'
          ? toolCall.rawInput
          : JSON.stringify(toolCall.rawInput, null, 2);
      console.log(`${t('cli', 'detailsLabel')}\n${details}`);
    }

    console.log(t('cli', 'choosePrompt'));
    options.forEach((opt: PermissionOption, index: number) => {
      console.log(`${index}. ${opt.name} (${opt.optionId})`);
    });

    console.log(
      `\n${t('cli', 'replyRangePrefix')}${options.length - 1}${t('cli', 'replyRangeSuffix')}`
    );
    console.log(t('cli', 'newInstructionHint'));
    console.log(t('cli', 'stopHint'));
    console.log(`${t('cli', 'requestIdLabel')}${requestId}`);
    console.log('─'.repeat(30) + '\n');

    process.stdout.write('> '); // 恢复提示符
  });

  // 创建任务队列引擎，传入完成回调（在终端显示）
  const queueEngine = new TaskQueueEngine(async (session: Session, response: IMResponse) => {
    if (isShuttingDown) return;
    console.log('\n' + '─'.repeat(50));
    console.log(t('cli', 'agentReplyLabel'));
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
    console.log(`\n${t('cli', 'goodbye')}`);
    isShuttingDown = true;
    rl.close();
    process.exit(0);
  });

  // 同时监听 process 的 SIGINT（某些终端 readline 捕获不到）
  process.on('SIGINT', () => {
    console.log(`\n${t('cli', 'goodbye')}`);
    isShuttingDown = true;
    rl.close();
    process.exit(0);
  });

  try {
    while (true) {
      if (isShuttingDown) break;

      const text = (await rl.question('> ')).trim();

      if (text.toLowerCase() === 'quit' || text.toLowerCase() === 'exit') {
        console.log(`\n${t('cli', 'goodbye')}`);
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
          console.log(t('cli', 'responseLabel'));
          console.log(response.message);
          if (response.data) {
            console.log(`\n${t('cli', 'dataLabel')}`, JSON.stringify(response.data, null, 2));
          }
          console.log('─'.repeat(50));
          console.log();
        }
        // 如果是 prompt，等待回调显示结果
      } catch (error) {
        console.error(t('cli', 'errorPrefix'), error);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err: Error) => console.error(err));
