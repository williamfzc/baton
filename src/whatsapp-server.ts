#!/usr/bin/env node
import * as path from 'node:path';
import { loadConfig } from './config/loader';
import { RepoManager } from './core/repo';
import { createLogger } from './utils/logger';
import { initI18n, resolveLocale, t } from './i18n';
import type { RepoInfo } from './types';
import { registerIMAdapter, createIMAdapter } from './im/factory';
import { IMPlatform } from './im/adapter';
import { WhatsAppWacliAdapter } from './im/whatsapp';

const logger = createLogger('WhatsAppServer');

export async function main(configPath?: string, workDir?: string, locale?: string) {
  let adapter: WhatsAppWacliAdapter | null = null;

  try {
    const config = loadConfig(configPath);
    initI18n({ defaultLocale: resolveLocale(locale ?? config.language) });

    if (!config.whatsapp?.wacli) {
      logger.error('Error: WhatsApp wacli configuration is required (whatsapp.wacli)');
      logger.error(t('server', 'configExampleHint'));
      process.exit(1);
    }

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

    registerIMAdapter(IMPlatform.WHATSAPP, (cfg, repo, manager) => {
      return new WhatsAppWacliAdapter(cfg, repo, manager);
    });

    adapter = createIMAdapter(
      IMPlatform.WHATSAPP,
      config,
      selectedRepo,
      repoManager
    ) as WhatsAppWacliAdapter;

    await adapter.start();

    const wacli = config.whatsapp?.wacli;
    logger.info(t('server', 'bannerWhatsApp'));
    logger.info(`\n${t('server', 'projectLabel')}${config.project.path}`);
    logger.info(`Mode: wacli polling`);
    logger.info(`wacli bin: ${wacli?.bin || 'wacli'}`);
    if (wacli?.storeDir) {
      logger.info(`wacli store: ${wacli.storeDir}`);
    }
    logger.info(`poll interval: ${wacli?.pollIntervalMs ?? 2000}ms`);
    logger.info(`\nWaiting for WhatsApp messages via wacli...\n`);

    const shutdown = async (signal: string) => {
      logger.info(
        `\n${t('server', 'shutdownReceivedPrefix')}${signal}${t('server', 'shutdownReceivedSuffix')}`
      );
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

    const keepAlive = setInterval(() => {}, 1000);
    process.on('exit', () => {
      clearInterval(keepAlive);
    });
  } catch (error) {
    logger.error({ error }, t('server', 'failedStart'));
    process.exit(1);
  }
}
