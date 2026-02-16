import * as path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { loadConfig } from './config/loader';
import { RepoManager } from './core/repo';
import { createLogger } from './utils/logger';
import { initI18n, resolveLocale, t } from './i18n';
import type { RepoInfo } from './types';
import { registerIMAdapter, createIMAdapter } from './im/factory';
import { IMPlatform } from './im/adapter';
import { DiscordAdapter } from './im/discord';

const logger = createLogger('DiscordServer');

interface DiscordInteractionPing {
  type?: number;
}

export async function main(configPath?: string, workDir?: string, locale?: string) {
  let adapter: DiscordAdapter | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  try {
    const config = loadConfig(configPath);
    initI18n({ defaultLocale: resolveLocale(locale ?? config.language) });
    const discordConfig = config.discord;

    if (!discordConfig?.botToken || !discordConfig.publicKey) {
      logger.error(t('server', 'configMissingDiscord'));
      logger.error(t('server', 'configCreateHintDiscord'));
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

    registerIMAdapter(IMPlatform.DISCORD, (cfg, repo, manager) => {
      return new DiscordAdapter(cfg, repo, manager);
    });

    adapter = createIMAdapter(
      IMPlatform.DISCORD,
      config,
      selectedRepo,
      repoManager
    ) as DiscordAdapter;

    const port = discordConfig.port || 8083;
    const webhookPath = discordConfig.webhookPath || '/webhook/discord';

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
          if (!verifyDiscordSignature(request, rawBody, discordConfig.publicKey)) {
            return new Response('Forbidden', { status: 403 });
          }

          const body = JSON.parse(rawBody) as DiscordInteractionPing;
          if (body.type === 1) {
            return new Response(JSON.stringify({ type: 1 }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }

          await adapter?.handleWebhook(body as Record<string, unknown>);
          return new Response(JSON.stringify({ type: 5 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        } catch (error) {
          logger.error({ error }, 'Failed to handle Discord webhook');
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

    logger.info(t('server', 'bannerDiscord'));
    logger.info(`\n${t('server', 'projectLabel')}${config.project.path}`);
    logger.info(`${t('server', 'webhookLabel')}http://localhost:${port}${webhookPath}`);
    logger.info(`\n${t('server', 'waitingDiscord')}\n`);

    const keepAlive = setInterval(() => {}, 1000);
    process.on('exit', () => {
      clearInterval(keepAlive);
    });
  } catch (error) {
    logger.error({ error }, t('server', 'failedStart'));
    process.exit(1);
  }
}

function verifyDiscordSignature(request: Request, rawBody: string, publicKey: string): boolean {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) {
    return false;
  }

  try {
    const message = Buffer.from(`${timestamp}${rawBody}`);
    const signatureBuffer = Buffer.from(signature, 'hex');
    const keyBuffer = Buffer.from(publicKey, 'hex');
    if (keyBuffer.length !== 32) {
      return false;
    }
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spki = Buffer.concat([spkiPrefix, keyBuffer]);
    const publicKeyObject = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verify(null, message, publicKeyObject, signatureBuffer);
  } catch {
    return false;
  }
}
