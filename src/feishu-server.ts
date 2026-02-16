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
import { initI18n, resolveLocale, t } from './i18n';
import type { RepoInfo } from './types';
import { registerIMAdapter, createIMAdapter } from './im/factory';
import { IMPlatform } from './im/adapter';

const logger = createLogger('FeishuServer');

export async function main(configPath?: string, workDir?: string, locale?: string) {
  let adapter: FeishuAdapter | null = null;

  try {
    // 加载配置
    const config = loadConfig(configPath);
    initI18n({ defaultLocale: resolveLocale(locale ?? config.language) });

    // 检查飞书配置
    if (!config.feishu) {
      logger.error(t('server', 'configMissingFeishu'));
      logger.error(t('server', 'configCreateHintFeishu'));
      logger.error(t('server', 'configExampleHint'));
      process.exit(1);
    }

    // 优先使用命令行参数指定的工作目录，其次使用配置文件中的路径
    const rootPath = path.resolve(workDir || config.project?.path || process.cwd());

    logger.info(`${t('server', 'scanRootLabel')}${rootPath}`);

    const repoManager = new RepoManager();
    let repos: RepoInfo[] = [];
    try {
      repos = await repoManager.scanFromRoot(rootPath);
    } catch (error) {
      logger.error({ error }, t('server', 'scanRepoFailed'));
    }

    let selectedRepo: RepoInfo | undefined;
    if (repos.length === 0) {
      logger.warn(t('server', 'noRepoFound'));
      selectedRepo = {
        name: path.basename(rootPath),
        path: rootPath,
        gitPath: path.join(rootPath, '.git'),
      };
      // 将当前目录添加到 repoManager，以便 /repo 命令可以显示
      repoManager.addRepo(selectedRepo);
    } else if (repos.length === 1) {
      selectedRepo = repos[0];
      logger.info(`${t('server', 'currentRepoLabel')}${selectedRepo.name}`);
    } else {
      logger.info(
        `\n${t('server', 'multiRepoTitlePrefix')}${repos.length}${t('server', 'multiRepoTitleSuffix')}`
      );
      repos.forEach((repo, idx) => {
        const relPath = repoManager.listRepos()[idx].path;
        logger.info(`   ${idx}. ${repo.name} (${relPath})`);
      });
      selectedRepo = repos[0];
      logger.info(`${t('server', 'currentRepoLabel')}${selectedRepo.name}`);
    }

    registerIMAdapter(IMPlatform.FEISHU, (cfg, repo, manager) => {
      return new FeishuAdapter(cfg, repo, manager);
    });

    adapter = createIMAdapter(
      IMPlatform.FEISHU,
      config,
      selectedRepo,
      repoManager
    ) as FeishuAdapter;

    // 优雅关闭处理
    const shutdown = async (signal: string) => {
      logger.info(
        `\n${t('server', 'shutdownReceivedPrefix')}${signal}${t('server', 'shutdownReceivedSuffix')}`
      );

      // 移除监听器避免重复触发
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);

      try {
        if (adapter) {
          await adapter.stop();
        }
        logger.info(t('server', 'gracefulShutdownSuccess'));
        process.exit(0);
      } catch (error) {
        logger.error({ error }, t('server', 'shutdownError'));
        process.exit(1);
      }
    };

    const sigintHandler = () => shutdown('SIGINT');
    const sigtermHandler = () => shutdown('SIGTERM');

    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);

    // 启动
    logger.info(t('server', 'bannerFeishu'));
    logger.info(`\n${t('server', 'projectLabel')}${config.project.path}`);
    logger.info(`${t('server', 'appIdLabel')}${config.feishu.appId}`);
    logger.info(
      `${t('server', 'domainLabel')}${config.feishu.domain || t('server', 'domainDefault')}`
    );
    logger.info(`\n${t('server', 'connectingFeishu')}\n`);

    await adapter.start();

    logger.info(t('server', 'connectedSuccess'));
    logger.info(`${t('server', 'pressCtrlC')}\n`);

    // 保持进程运行（使用 setInterval 而不是 stdin.resume）
    const keepAlive = setInterval(() => {}, 1000);

    // 清理 keepAlive
    process.on('exit', () => {
      clearInterval(keepAlive);
    });
  } catch (error) {
    logger.error({ error }, t('server', 'failedStart'));
    process.exit(1);
  }
}
