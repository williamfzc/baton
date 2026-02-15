#!/usr/bin/env node
/**
 * Baton 主入口文件
 * 负责解析命令行参数，并根据配置自动选择或手动指定运行模式（CLI/飞书）
 * 支持 --help、--mode、--dir 等入口参数
 */
import { loadConfig } from './config/loader.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('Main');
type RunMode = 'auto' | 'cli' | 'feishu' | 'telegram' | 'whatsapp' | 'slack';

function printHelp(): void {
  console.log(
    `
Usage:
  baton [mode] [workdir]
  baton --mode <auto|cli|feishu|telegram|whatsapp|slack> [--dir <path>]
  baton -m <auto|cli|feishu|telegram|whatsapp|slack> [-C <path>]

Modes:
  auto      根据配置自动选择（默认）
  cli       强制启动命令行交互模式
  feishu    强制启动飞书模式
  telegram  强制启动 Telegram 模式
  whatsapp  强制启动 WhatsApp 模式
  slack     强制启动 Slack 模式

Options:
  -h, --help              显示帮助
  -m, --mode <mode>       指定启动模式
  -d, --dir <path>        指定工作目录（等价于 -C）
  -C <path>               指定工作目录
  -c, --config <path>     指定配置文件路径（仅 feishu/telegram/auto 模式使用）

Examples:
  baton
  baton cli
  baton feishu /path/to/workspace
  baton telegram /path/to/workspace
  baton whatsapp /path/to/workspace
  baton slack /path/to/workspace
  baton --mode cli --dir /path/to/workspace
  baton --mode auto --config ./baton.config.json
`.trim()
  );
}

function parseArgs(argv: string[]): { mode: RunMode; workDir?: string; configPath?: string } {
  let mode: RunMode = 'auto';
  let workDir: string | undefined;
  let configPath: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    if (arg === '-m' || arg === '--mode') {
      const value = argv[++i];
      if (!value || !['auto', 'cli', 'feishu', 'telegram', 'whatsapp', 'slack'].includes(value)) {
        throw new Error(
          `无效 mode: ${value ?? '(empty)'}，可选: auto | cli | feishu | telegram | whatsapp | slack`
        );
      }
      mode = value as RunMode;
      continue;
    }

    if (arg === '-d' || arg === '--dir' || arg === '-C') {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${arg} 需要一个路径参数`);
      }
      workDir = value;
      continue;
    }

    if (arg === '-c' || arg === '--config') {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${arg} 需要一个文件路径参数`);
      }
      configPath = value;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`未知参数: ${arg}`);
    }

    positionals.push(arg);
  }

  // 兼容旧用法: baton [mode] [workdir]
  if (
    positionals[0] &&
    ['auto', 'cli', 'feishu', 'telegram', 'whatsapp', 'slack'].includes(positionals[0])
  ) {
    mode = positionals[0] as RunMode;
    if (!workDir && positionals[1]) {
      workDir = positionals[1];
    }
  } else if (!workDir && positionals[0]) {
    workDir = positionals[0];
  }

  return { mode, workDir, configPath };
}

async function main() {
  const { mode, workDir, configPath } = parseArgs(process.argv.slice(2));

  if (mode === 'cli') {
    // 强制 CLI 模式
    const { main: cliMain } = await import('./cli.js');
    await cliMain(workDir);
  } else if (mode === 'feishu') {
    // 强制飞书模式
    const { main: feishuMain } = await import('./feishu-server.js');
    await feishuMain(configPath, workDir);
  } else if (mode === 'telegram') {
    const { main: telegramMain } = await import('./telegram-server.js');
    await telegramMain(configPath, workDir);
  } else if (mode === 'whatsapp') {
    const { main: whatsappMain } = await import('./whatsapp-server.js');
    await whatsappMain(configPath, workDir);
  } else if (mode === 'slack') {
    const { main: slackMain } = await import('./slack-server.js');
    await slackMain(configPath, workDir);
  } else {
    // 自动判断
    const config = loadConfig(configPath);

    if (config.feishu?.appId && config.feishu?.appSecret) {
      logger.info('🤖 检测到飞书配置，启动飞书模式...');
      logger.info('   (使用 bun run start -- cli 强制 CLI 模式)');
      const { main: feishuMain } = await import('./feishu-server.js');
      await feishuMain(configPath, workDir);
    } else if (config.telegram?.botToken) {
      logger.info('🤖 检测到 Telegram 配置，启动 Telegram 模式...');
      logger.info('   (使用 bun run start -- cli 强制 CLI 模式)');
      const { main: telegramMain } = await import('./telegram-server.js');
      await telegramMain(configPath, workDir);
    } else if (config.whatsapp?.accessToken && config.whatsapp?.phoneNumberId) {
      logger.info('🤖 检测到 WhatsApp 配置，启动 WhatsApp 模式...');
      logger.info('   (使用 bun run start -- cli 强制 CLI 模式)');
      const { main: whatsappMain } = await import('./whatsapp-server.js');
      await whatsappMain(configPath, workDir);
    } else if (config.slack?.botToken) {
      logger.info('🤖 检测到 Slack 配置，启动 Slack 模式...');
      logger.info('   (使用 bun run start -- cli 强制 CLI 模式)');
      const { main: slackMain } = await import('./slack-server.js');
      await slackMain(configPath, workDir);
    } else {
      logger.info('💻 未检测到飞书配置，启动 CLI 模式...');
      logger.info('   (使用 bun run start -- feishu/telegram/whatsapp/slack 强制 IM 模式)');
      const { main: cliMain } = await import('./cli.js');
      await cliMain(workDir);
    }
  }
}

main().catch(err => {
  logger.error(err);
  printHelp();
  process.exit(1);
});
