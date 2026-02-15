#!/usr/bin/env node
import * as path from 'node:path';
import { loadConfig } from './config/loader';
import { RepoManager } from './core/repo';
import { createLogger } from './utils/logger';
import type { RepoInfo } from './types';
import { registerIMAdapter, createIMAdapter } from './im/factory';
import { IMPlatform } from './im/adapter';
import { TelegramAdapter } from './im/telegram';

const logger = createLogger('TelegramServer');

export async function main(configPath?: string, workDir?: string) {
  let adapter: TelegramAdapter | null = null;

  try {
    const config = loadConfig(configPath);

    if (!config.telegram?.botToken) {
      logger.error('Error: Telegram configuration is required');
      logger.error('Please create baton.config.json with telegram settings');
      logger.error('See baton.config.example.json for reference');
      process.exit(1);
    }

    const rootPath = path.resolve(workDir || config.project?.path || process.cwd());

    logger.info(`📂 扫描目录: ${rootPath}`);

    const repoManager = new RepoManager();
    let repos: RepoInfo[] = [];
    try {
      repos = await repoManager.scanFromRoot(rootPath);
    } catch (error) {
      logger.error({ error }, '扫描仓库失败');
    }

    let selectedRepo: RepoInfo | undefined;
    if (repos.length === 0) {
      logger.warn('⚠️ 未发现任何 Git 仓库，使用当前目录作为工作目录');
      selectedRepo = {
        name: path.basename(rootPath),
        path: rootPath,
        gitPath: path.join(rootPath, '.git'),
      };
      repoManager.addRepo(selectedRepo);
    } else if (repos.length === 1) {
      selectedRepo = repos[0];
      logger.info(`📂 当前仓库: ${selectedRepo.name}`);
    } else {
      logger.info(`\n📦 发现 ${repos.length} 个 Git 仓库`);
      repos.forEach((repo, idx) => {
        const relPath = repoManager.listRepos()[idx].path;
        logger.info(`   ${idx}. ${repo.name} (${relPath})`);
      });
      selectedRepo = repos[0];
      logger.info(`📂 当前仓库: ${selectedRepo.name}`);
    }

    registerIMAdapter(IMPlatform.TELEGRAM, (cfg, repo, manager) => {
      return new TelegramAdapter(cfg, repo, manager);
    });

    adapter = createIMAdapter(
      IMPlatform.TELEGRAM,
      config,
      selectedRepo,
      repoManager
    ) as TelegramAdapter;

    const shutdown = async (signal: string) => {
      logger.info(`\nReceived ${signal}, shutting down gracefully...`);
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);

      try {
        if (adapter) {
          await adapter.stop();
        }
        logger.info('✅ Gracefully shut down');
        process.exit(0);
      } catch (error) {
        logger.error({ error }, 'Error during shutdown');
        process.exit(1);
      }
    };

    const sigintHandler = () => shutdown('SIGINT');
    const sigtermHandler = () => shutdown('SIGTERM');

    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);

    logger.info('╔════════════════════════════════════════╗');
    logger.info('║        Baton Telegram Server           ║');
    logger.info('╚════════════════════════════════════════╝');
    logger.info(`\nProject: ${config.project.path}`);
    logger.info('\nConnecting to Telegram Bot API...\n');

    await adapter.start();

    logger.info('✅ Connected successfully!');
    logger.info('Press Ctrl+C to exit\n');

    const keepAlive = setInterval(() => {}, 1000);
    process.on('exit', () => {
      clearInterval(keepAlive);
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}
