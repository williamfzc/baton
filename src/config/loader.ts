/**
 * 配置加载器
 * 负责从配置文件和环境变量加载应用配置，支持多层级配置合并
 * 实现配置优先级：环境变量 > 配置文件 > 默认值
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BatonConfig } from './types';
import { DEFAULT_CONFIG } from './types';

const CONFIG_FILE_NAMES = ['baton.config.json', '.batonrc.json', 'baton.json'];

/**
 * 加载配置
 * 优先级：环境变量 > 配置文件 > 默认值
 */
export function loadConfig(configPath?: string): BatonConfig {
  // 1. 加载配置文件
  const fileConfig = loadFileConfig(configPath);

  // 2. 从环境变量覆盖敏感信息
  const envConfig = loadEnvConfig();

  // 3. 合并配置（环境变量优先级最高）
  return mergeConfigs(fileConfig, envConfig);
}

function loadFileConfig(configPath?: string): Partial<BatonConfig> {
  // 如果指定了配置文件路径
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return parseConfig(readFileSync(configPath, 'utf-8'));
  }

  // 在当前目录和上级目录查找配置文件
  let currentDir = process.cwd();
  for (let i = 0; i < 5; i++) {
    // 最多向上查找5层
    for (const fileName of CONFIG_FILE_NAMES) {
      const fullPath = resolve(currentDir, fileName);
      if (existsSync(fullPath)) {
        console.log(`[Config] Loaded from ${fullPath}`);
        return parseConfig(readFileSync(fullPath, 'utf-8'));
      }
    }

    // 向上级目录查找
    const parentDir = resolve(currentDir, '..');
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  // 没有找到配置文件，返回空对象
  return {};
}

function loadEnvConfig(): Partial<BatonConfig> {
  const envConfig: Partial<BatonConfig> = {};

  // 从环境变量读取飞书配置
  const appId = process.env.BATON_FEISHU_APP_ID;
  const appSecret = process.env.BATON_FEISHU_APP_SECRET;
  const domain = process.env.BATON_FEISHU_DOMAIN;

  if (appId || appSecret || domain) {
    envConfig.feishu = {
      appId: appId || '',
      appSecret: appSecret || '',
      domain: (domain as 'feishu' | 'lark') || 'feishu',
    };

    console.log('[Config] Loaded Feishu credentials from environment variables');
  }

  const telegramToken = process.env.BATON_TELEGRAM_BOT_TOKEN;
  const telegramApiBase = process.env.BATON_TELEGRAM_API_BASE;

  if (telegramToken || telegramApiBase) {
    envConfig.telegram = {
      botToken: telegramToken || '',
      apiBase: telegramApiBase || undefined,
    };

    console.log('[Config] Loaded Telegram credentials from environment variables');
  }

  const whatsappAccessToken = process.env.BATON_WHATSAPP_ACCESS_TOKEN;
  const whatsappPhoneNumberId = process.env.BATON_WHATSAPP_PHONE_NUMBER_ID;
  const whatsappVerifyToken = process.env.BATON_WHATSAPP_VERIFY_TOKEN;
  const whatsappApiBase = process.env.BATON_WHATSAPP_API_BASE;
  const whatsappPort = process.env.BATON_WHATSAPP_PORT;
  const whatsappWebhookPath = process.env.BATON_WHATSAPP_WEBHOOK_PATH;

  if (
    whatsappAccessToken ||
    whatsappPhoneNumberId ||
    whatsappVerifyToken ||
    whatsappApiBase ||
    whatsappPort ||
    whatsappWebhookPath
  ) {
    envConfig.whatsapp = {
      accessToken: whatsappAccessToken || '',
      phoneNumberId: whatsappPhoneNumberId || '',
      verifyToken: whatsappVerifyToken || undefined,
      apiBase: whatsappApiBase || undefined,
      port: whatsappPort ? Number(whatsappPort) : undefined,
      webhookPath: whatsappWebhookPath || undefined,
    };

    console.log('[Config] Loaded WhatsApp credentials from environment variables');
  }

  const slackBotToken = process.env.BATON_SLACK_BOT_TOKEN;
  const slackSigningSecret = process.env.BATON_SLACK_SIGNING_SECRET;
  const slackApiBase = process.env.BATON_SLACK_API_BASE;
  const slackPort = process.env.BATON_SLACK_PORT;
  const slackWebhookPath = process.env.BATON_SLACK_WEBHOOK_PATH;

  if (slackBotToken || slackSigningSecret || slackApiBase || slackPort || slackWebhookPath) {
    envConfig.slack = {
      botToken: slackBotToken || '',
      signingSecret: slackSigningSecret || undefined,
      apiBase: slackApiBase || undefined,
      port: slackPort ? Number(slackPort) : undefined,
      webhookPath: slackWebhookPath || undefined,
    };

    console.log('[Config] Loaded Slack credentials from environment variables');
  }

  // 从环境变量读取项目路径
  const projectPath = process.env.BATON_PROJECT_PATH;
  if (projectPath) {
    envConfig.project = {
      path: projectPath,
      name: process.env.BATON_PROJECT_NAME || 'default',
    };
  }

  // 从环境变量读取 ACP executor（兼容下划线写法）
  const executor = process.env.BATON_EXECUTOR?.replace(/_/g, '-');
  if (executor) {
    envConfig.acp = {
      ...(envConfig.acp || {}),
      executor: executor as NonNullable<BatonConfig['acp']>['executor'],
    };
  }

  return envConfig;
}

function parseConfig(content: string): Partial<BatonConfig> {
  try {
    return JSON.parse(content) as Partial<BatonConfig>;
  } catch (error) {
    throw new Error(`Failed to parse config file: ${error}`);
  }
}

function mergeConfigs(
  fileConfig: Partial<BatonConfig>,
  envConfig: Partial<BatonConfig>
): BatonConfig {
  // 环境变量优先级最高
  const merged: BatonConfig = {
    project: {
      path: envConfig.project?.path || fileConfig.project?.path || DEFAULT_CONFIG.project!.path,
      name: envConfig.project?.name || fileConfig.project?.name || DEFAULT_CONFIG.project!.name,
    },
    feishu: envConfig.feishu || fileConfig.feishu,
    telegram: envConfig.telegram || fileConfig.telegram,
    whatsapp: envConfig.whatsapp || fileConfig.whatsapp,
    slack: envConfig.slack || fileConfig.slack,
    acp: {
      command: envConfig.acp?.command || fileConfig.acp?.command,
      args: envConfig.acp?.args || fileConfig.acp?.args,
      cwd: envConfig.acp?.cwd || fileConfig.acp?.cwd,
      env: envConfig.acp?.env || fileConfig.acp?.env,
      executor: envConfig.acp?.executor || fileConfig.acp?.executor || DEFAULT_CONFIG.acp?.executor,
    },
  };

  return merged;
}
