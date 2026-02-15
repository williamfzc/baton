#!/usr/bin/env node
import * as path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config/loader';
import { RepoManager } from './core/repo';
import { createLogger } from './utils/logger';
import type { RepoInfo } from './types';
import { registerIMAdapter, createIMAdapter } from './im/factory';
import { IMPlatform } from './im/adapter';
import { SlackAdapter } from './im/slack';

const logger = createLogger('SlackServer');

interface SlackUrlVerification {
  type?: string;
  challenge?: string;
}

export async function main(configPath?: string, workDir?: string) {
  let adapter: SlackAdapter | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  try {
    const config = loadConfig(configPath);

    const slackConfig = config.slack;

    if (!slackConfig?.botToken) {
      logger.error('Error: Slack configuration is required');
      logger.error('Please create baton.config.json with slack settings');
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

    registerIMAdapter(IMPlatform.SLACK, (cfg, repo, manager) => {
      return new SlackAdapter(cfg, repo, manager);
    });

    adapter = createIMAdapter(
      IMPlatform.SLACK,
      config,
      selectedRepo,
      repoManager
    ) as SlackAdapter;

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
      logger.info(`\nReceived ${signal}, shutting down gracefully...`);
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);

      try {
        if (adapter) {
          await adapter.stop();
        }
        if (server) {
          server.stop();
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
    logger.info('║        Baton Slack Server              ║');
    logger.info('╚════════════════════════════════════════╝');
    logger.info(`\nProject: ${config.project.path}`);
    logger.info(`Webhook: http://localhost:${port}${webhookPath}`);
    logger.info('\nWaiting for Slack webhook...\n');

    const keepAlive = setInterval(() => {}, 1000);
    process.on('exit', () => {
      clearInterval(keepAlive);
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
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
