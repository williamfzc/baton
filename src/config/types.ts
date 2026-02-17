/**
 * Baton 配置类型定义
 * 定义应用配置的数据结构和 TypeScript 类型，包括项目、飞书、ACP 等配置
 * 确保配置项的类型安全和代码提示支持
 */

import type { Locale } from '../i18n/index.js';

export interface BatonConfig {
  // 项目配置
  project: {
    path: string;
    name: string;
  };

  language?: Locale;

  // 飞书配置（长链接模式）
  feishu?: FeishuConfig;

  telegram?: TelegramConfig;

  whatsapp?: WhatsAppConfig;

  slack?: SlackConfig;

  discord?: DiscordConfig;

  // ACP 配置
  acp?: ACPConfig;
}

export interface FeishuConfig {
  // 应用凭证
  appId: string;
  appSecret: string;

  // 域名配置（飞书/ Lark）
  domain?: 'feishu' | 'lark';

  // 消息卡片配置
  card?: {
    // 权限确认卡片超时时间（秒）
    permissionTimeout: number;
  };
}

export interface TelegramConfig {
  botToken: string;
  apiBase?: string;
  permissionTimeout?: number;
}

export interface WhatsAppConfig {
  permissionTimeout?: number;

  /**
   * wacli 轮询模式配置
   */
  wacli?: {
    /** wacli 可执行文件路径或命令名（默认: wacli） */
    bin?: string;
    /** wacli store 目录（默认: ~/.wacli） */
    storeDir?: string;
    /** 轮询间隔（毫秒，默认: 2000） */
    pollIntervalMs?: number;
    /** 每轮 sync 的 idle-exit（毫秒，默认: 1500） */
    syncIdleExitMs?: number;
    /** 拉取 messages list 的条数上限（默认: 50） */
    listLimit?: number;
    /** 启动时从哪个时间点之后开始处理（RFC3339 或 YYYY-MM-DD；默认: 现在） */
    initialAfter?: string;
    /** 是否把非文本消息转成占位文本（默认: false） */
    includeNonText?: boolean;
  };
}

export interface SlackConfig {
  botToken: string;
  signingSecret?: string;
  apiBase?: string;
  permissionTimeout?: number;
  port?: number;
  webhookPath?: string;
}

export interface DiscordConfig {
  botToken: string;
  publicKey: string;
  apiBase?: string;
  permissionTimeout?: number;
  port?: number;
  webhookPath?: string;
}

export interface ACPConfig {
  // 自定义 Agent 启动命令（可选，不填则按 executor 使用内置命令）
  command?: string;
  args?: string[];

  // 自定义工作目录（可选，支持相对路径）
  cwd?: string;

  // 环境变量
  env?: Record<string, string>;

  // Executor 类型（opencode, claude-code, codex）
  executor?: ACPEXecutor;
}

// 支持的 ACP Executor 类型
export type ACPEXecutor = 'opencode' | 'claude-code' | 'codex';

// Executor 配置映射
export const EXECUTOR_COMMANDS: Record<ACPEXecutor, { command: string; args: string[] }> = {
  opencode: { command: 'opencode', args: ['acp'] },
  'claude-code': { command: 'claude-code-acp', args: [] },
  codex: { command: 'codex-acp', args: [] },
};

// 默认配置
export const DEFAULT_CONFIG: Partial<BatonConfig> = {
  project: {
    path: process.cwd(),
    name: 'default',
  },
  language: 'en',
  acp: {
    executor: 'opencode',
  },
};
