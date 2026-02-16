#!/usr/bin/env node
import * as path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config/loader';
import { RepoManager } from './core/repo';
import { createLogger } from './utils/logger';
import { initI18n, resolveLocale, t } from './i18n';
import type { RepoInfo } from './types';
import { registerIMAdapter, createIMAdapter } from './im/factory';
import { IMPlatform } from './im/adapter';
import { SlackAdapter } from './im/slack';

const logger = createLogger('SlackServer');

interface SlackUrlVerification {
  type?: string;
  challenge?: string;
}

export async function main(configPath?: string, workDir?: string, locale?: string) {
  let adapter: SlackAdapter | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  try {
    const config = loadConfig(configPath);
    initI18n({ defaultLocale: resolveLocale(locale ?? config.language) });

    const slackConfig = config.slack;

    if (!slackConfig?.botToken) {
      logger.error(t('server', 'configMissingSlack'));
      logger.error(t('server', 'configCreateHintSlack'));
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

    registerIMAdapter(IMPlatform.SLACK, (cfg, repo, manager) => {
      return new SlackAdapter(cfg, repo, manager);
    });

    adapter = createIMAdapter(IMPlatform.SLACK, config, selectedRepo, repoManager) as SlackAdapter;

    const port = slackConfig.port || 8081;
    const webhookPath = slackConfig.webhookPath || '/webhook/slack';

    server = Bun.serve({
      port,
      fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname !== webhookPath) {
          return new Response('Not Found', { status: 404 });
        }

        if (request.method !== 'POST') {
          return new Response('Method Not Allowed', { status: 405 });
        }

        try {
          const rawBody = await request.text();
          if (
            slackConfig.signingSecret &&
            !verifySlackSignature(request, rawBody, slackConfig.signingSecret)
          ) {
            return new Response('Forbidden', { status: 403 });
          }

          const body = JSON.parse(rawBody) as SlackUrlVerification;
          if (body.type === 'url_verification' && body.challenge) {
            return new Response(JSON.stringify({ challenge: body.challenge }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }

          await adapter?.handleWebhook(body as Record<string, unknown>);
          return new Response('OK', { status: 200 });
        } catch (error) {
          logger.error({ error }, 'Failed to handle Slack webhook');
          return new Response('Bad Request', { status: 400 });
        }
      },
    });

    await adapter.start();

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
        if (server) {
          server.stop();
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

    logger.info(t('server', 'bannerSlack'));
    logger.info(`\n${t('server', 'projectLabel')}${config.project.path}`);
    logger.info(`${t('server', 'webhookLabel')}http://localhost:${port}${webhookPath}`);
    logger.info(`\n${t('server', 'waitingSlack')}\n`);

    const keepAlive = setInterval(() => {}, 1000);
    process.on('exit', () => {
      clearInterval(keepAlive);
    });
  } catch (error) {
    logger.error({ error }, t('server', 'failedStart'));
    process.exit(1);
  }
}

function verifySlackSignature(request: Request, rawBody: string, signingSecret: string): boolean {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!timestamp || !signature) {
    return false;
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const digest = createHmac('sha256', signingSecret).update(base).digest('hex');
  const computed = `v0=${digest}`;
  if (computed.length !== signature.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}
