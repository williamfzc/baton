#!/usr/bin/env node
import * as path from 'node:path';
import { loadConfig } from './config/loader';
import { RepoManager } from './core/repo';
import { createLogger } from './utils/logger';
import type { RepoInfo } from './types';
import { registerIMAdapter, createIMAdapter } from './im/factory';
import { IMPlatform } from './im/adapter';
import { WhatsAppAdapter } from './im/whatsapp';

const logger = createLogger('WhatsAppServer');

export async function main(configPath?: string, workDir?: string) {
  let adapter: WhatsAppAdapter | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  try {
    const config = loadConfig(configPath);

    if (!config.whatsapp?.accessToken || !config.whatsapp?.phoneNumberId) {
      logger.error('Error: WhatsApp configuration is required');
      logger.error('Please create baton.config.json with whatsapp settings');
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

    registerIMAdapter(IMPlatform.WHATSAPP, (cfg, repo, manager) => {
      return new WhatsAppAdapter(cfg, repo, manager);
    });

    adapter = createIMAdapter(
      IMPlatform.WHATSAPP,
      config,
      selectedRepo,
      repoManager
    ) as WhatsAppAdapter;

    const port = config.whatsapp.port || 8080;
    const webhookPath = config.whatsapp.webhookPath || '/webhook/whatsapp';
    const verifyToken = config.whatsapp.verifyToken;

    server = Bun.serve({
      port,
      fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname !== webhookPath) {
          return new Response('Not Found', { status: 404 });
        }

        if (request.method === 'GET') {
          const mode = url.searchParams.get('hub.mode');
          const token = url.searchParams.get('hub.verify_token');
          const challenge = url.searchParams.get('hub.challenge');

          if (mode === 'subscribe' && token && verifyToken && token === verifyToken) {
            return new Response(challenge || '', { status: 200 });
          }

          return new Response('Forbidden', { status: 403 });
        }

        if (request.method === 'POST') {
          try {
            const body = (await request.json()) as unknown;
            await adapter?.handleWebhook(body as Record<string, unknown>);
            return new Response('OK', { status: 200 });
          } catch (error) {
            logger.error({ error }, 'Failed to handle WhatsApp webhook');
            return new Response('Bad Request', { status: 400 });
          }
        }

        return new Response('Method Not Allowed', { status: 405 });
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
    logger.info('║        Baton WhatsApp Server           ║');
    logger.info('╚════════════════════════════════════════╝');
    logger.info(`\nProject: ${config.project.path}`);
    logger.info(`Webhook: http://localhost:${port}${webhookPath}`);
    logger.info('\nWaiting for WhatsApp webhook...\n');

    const keepAlive = setInterval(() => {}, 1000);
    process.on('exit', () => {
      clearInterval(keepAlive);
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}
