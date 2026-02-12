#!/usr/bin/env node
/**
 * 飞书服务器入口
 * 启动 WebSocket 长链接连接到飞书平台，接收和处理消息事件
 * 生产环境部署的主要入口，支持内网运行无需公网暴露
 * 支持多仓库切换
 */
import * as path from 'node:path';
import { loadConfig } from './config/loader';
import { FeishuAdapter } from './im/feishu';
import { RepoManager } from './core/repo';
import { createLogger } from './utils/logger';
import type { RepoInfo } from './types';

const logger = createLogger('FeishuServer');

export async function main(configPath?: string, workDir?: string) {
  let adapter: FeishuAdapter | null = null;

  try {
    // 加载配置
    const config = loadConfig(configPath);

    // 检查飞书配置
    if (!config.feishu) {
      logger.error('Error: Feishu configuration is required');
      logger.error('Please create baton.config.json with feishu settings');
      logger.error('See baton.config.example.json for reference');
      process.exit(1);
    }

    // 优先使用命令行参数指定的工作目录，其次使用配置文件中的路径
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
      // 将当前目录添加到 repoManager，以便 /repo 命令可以显示
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

    // 创建飞书适配器
    adapter = new FeishuAdapter(config, selectedRepo, repoManager);

    // 优雅关闭处理
    const shutdown = async (signal: string) => {
      logger.info(`\nReceived ${signal}, shutting down gracefully...`);

      // 移除监听器避免重复触发
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

    // 启动
    logger.info('╔════════════════════════════════════════╗');
    logger.info('║        Baton Feishu Server             ║');
    logger.info('║        (WebSocket Long Connection)     ║');
    logger.info('╚════════════════════════════════════════╝');
    logger.info(`\nProject: ${config.project.path}`);
    logger.info(`App ID: ${config.feishu.appId}`);
    logger.info(`Domain: ${config.feishu.domain || 'feishu'}`);
    logger.info('\nConnecting to Feishu via WebSocket...\n');

    await adapter.start();

    logger.info('✅ Connected successfully!');
    logger.info('Press Ctrl+C to exit\n');

    // 保持进程运行（使用 setInterval 而不是 stdin.resume）
    const keepAlive = setInterval(() => {}, 1000);

    // 清理 keepAlive
    process.on('exit', () => {
      clearInterval(keepAlive);
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}
