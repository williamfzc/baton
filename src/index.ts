#!/usr/bin/env node
/**
 * Baton 主入口文件
 * 负责解析命令行参数，并根据配置自动选择或手动指定运行模式（CLI/飞书）
 * 支持 --help、--mode、--dir 等入口参数
 */
import { loadConfig } from './config/loader.js';
import { createLogger } from './utils/logger.js';
import { t } from './i18n/index.js';

const logger = createLogger('Main');
type RunMode = 'auto' | 'cli' | 'feishu' | 'telegram' | 'whatsapp' | 'slack' | 'discord';

function printHelp(): void {
  console.log(t('main', 'helpText'));
}

function parseArgs(argv: string[]): {
  mode: RunMode;
  workDir?: string;
  configPath?: string;
  lang?: string;
} {
  let mode: RunMode = 'auto';
  let workDir: string | undefined;
  let configPath: string | undefined;
  let lang: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }

    if (arg === '-m' || arg === '--mode') {
      const value = argv[++i];
      if (
        !value ||
        !['auto', 'cli', 'feishu', 'telegram', 'whatsapp', 'slack', 'discord'].includes(value)
      ) {
        throw new Error(
          `${t('main', 'invalidModePrefix')}${value ?? t('main', 'emptyValue')}${t(
            'main',
            'invalidModeSuffix'
          )}`
        );
      }
      mode = value as RunMode;
      continue;
    }

    if (arg === '-d' || arg === '--dir' || arg === '-C') {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${arg}${t('main', 'missingPathArgSuffix')}`);
      }
      workDir = value;
      continue;
    }

    if (arg === '-c' || arg === '--config') {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${arg}${t('main', 'missingFileArgSuffix')}`);
      }
      configPath = value;
      continue;
    }

    if (arg === '-l' || arg === '--lang' || arg === '--locale') {
      const value = argv[++i];
      if (!value) {
        throw new Error(`${arg}${t('main', 'missingLangArgSuffix')}`);
      }
      lang = value;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`${t('main', 'unknownArgPrefix')}${arg}`);
    }

    positionals.push(arg);
  }

  // 兼容旧用法: baton [mode] [workdir]
  if (
    positionals[0] &&
    ['auto', 'cli', 'feishu', 'telegram', 'whatsapp', 'slack', 'discord'].includes(positionals[0])
  ) {
    mode = positionals[0] as RunMode;
    if (!workDir && positionals[1]) {
      workDir = positionals[1];
    }
  } else if (!workDir && positionals[0]) {
    workDir = positionals[0];
  }

  return { mode, workDir, configPath, lang };
}

async function main() {
  const { mode, workDir, configPath, lang } = parseArgs(process.argv.slice(2));

  if (mode === 'cli') {
    // 强制 CLI 模式
    const { main: cliMain } = await import('./cli.js');
    await cliMain(workDir, lang);
  } else if (mode === 'feishu') {
    // 强制飞书模式
    const { main: feishuMain } = await import('./feishu-server.js');
    await feishuMain(configPath, workDir, lang);
  } else if (mode === 'telegram') {
    const { main: telegramMain } = await import('./telegram-server.js');
    await telegramMain(configPath, workDir, lang);
  } else if (mode === 'whatsapp') {
    const { main: whatsappMain } = await import('./whatsapp-server.js');
    await whatsappMain(configPath, workDir, lang);
  } else if (mode === 'slack') {
    const { main: slackMain } = await import('./slack-server.js');
    await slackMain(configPath, workDir, lang);
  } else if (mode === 'discord') {
    const { main: discordMain } = await import('./discord-server.js');
    await discordMain(configPath, workDir, lang);
  } else {
    // 自动判断
    const config = loadConfig(configPath);

    const hasWhatsAppWacliConfig =
      !!config.whatsapp?.wacli?.storeDir ||
      !!config.whatsapp?.wacli?.bin;

    if (config.feishu?.appId && config.feishu?.appSecret) {
      logger.info(t('main', 'detectFeishu'));
      logger.info(t('main', 'forceCliHint'));
      const { main: feishuMain } = await import('./feishu-server.js');
      await feishuMain(configPath, workDir, lang);
    } else if (config.telegram?.botToken) {
      logger.info(t('main', 'detectTelegram'));
      logger.info(t('main', 'forceCliHint'));
      const { main: telegramMain } = await import('./telegram-server.js');
      await telegramMain(configPath, workDir, lang);
    } else if (hasWhatsAppWacliConfig) {
      logger.info(t('main', 'detectWhatsApp'));
      logger.info(t('main', 'forceCliHint'));
      const { main: whatsappMain } = await import('./whatsapp-server.js');
      await whatsappMain(configPath, workDir, lang);
    } else if (config.slack?.botToken) {
      logger.info(t('main', 'detectSlack'));
      logger.info(t('main', 'forceCliHint'));
      const { main: slackMain } = await import('./slack-server.js');
      await slackMain(configPath, workDir, lang);
    } else if (config.discord?.botToken) {
      logger.info(t('main', 'detectDiscord'));
      logger.info(t('main', 'forceCliHint'));
      const { main: discordMain } = await import('./discord-server.js');
      await discordMain(configPath, workDir, lang);
    } else {
      logger.info(t('main', 'detectCliFallback'));
      logger.info(t('main', 'forceImHint'));
      const { main: cliMain } = await import('./cli.js');
      await cliMain(workDir, lang);
    }
  }
}

main().catch(err => {
  logger.error(err);
  printHelp();
  process.exit(1);
});
