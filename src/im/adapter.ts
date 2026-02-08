/**
 * IM 适配器接口定义
 * 定义所有 IM 平台（飞书、Slack、CLI 等）必须实现的通用接口
 * 将核心逻辑与具体 IM 平台解耦，支持多平台接入
 */

import type { IMResponse, Session } from '../types.js';
import { IMPlatform } from './types.js';
import type { UniversalCard } from './types.js';

export { IMPlatform };
export type { UniversalCard };


/**
 * IM 回复选项
 */
export interface IMReplyOptions {
  // 是否静默发送（不显示"正在输入"等状态）
  silent?: boolean;
  // 回复特定消息（用于线程回复）
  replyToMessageId?: string;
  // 额外元数据（各平台特定）
  metadata?: Record<string, any>;
}

/**
 * IM 消息格式
 */
export interface IMMessageFormat {
  // 纯文本内容
  text?: string;
  // Markdown 内容
  markdown?: string;
  // 通用卡片内容
  card?: UniversalCard;
  // 代码块
  code?: {
    language: string;
    content: string;
  };
}

/**
 * IM 适配器接口
 * 所有 IM 平台都需要实现此接口
 */
export interface IMAdapter {
  /**
   * 平台类型
   */
  readonly platform: IMPlatform;

  /**
   * 启动 IM 连接
   */
  start(): Promise<void>;

  /**
   * 停止 IM 连接
   */
  stop(): Promise<void>;

  /**
   * 发送消息
   * @param chatId 聊天/频道 ID
   * @param message 消息内容
   * @param options 发送选项
   * @returns 消息 ID
   */
  sendMessage(_chatId: string, message: IMMessageFormat, options?: IMReplyOptions): Promise<string>;

  /**
   * 发送回复（引用特定消息）
   * @param chatId 聊天/频道 ID
   * @param messageId 要回复的消息 ID
   * @param message 消息内容
   * @returns 消息 ID
   */
  sendReply(_chatId: string, _messageId: string | undefined, message: IMMessageFormat): Promise<string>;

  /**
   * 更新消息（用于流式响应或编辑消息）
   * @param chatId 聊天/频道 ID
   * @param messageId 要更新的消息 ID
   * @param message 新的消息内容
   */
  updateMessage?(_chatId: string, _messageId: string, message: IMMessageFormat): Promise<void>;

  /**
   * 添加消息反应（如飞书的表情回复）
   * @param chatId 聊天/频道 ID
   * @param messageId 消息 ID
   * @param reaction 反应类型（如 emoji 名称）
   */
  addReaction?(_chatId: string, _messageId: string, reaction: string): Promise<void>;

  /**
   * 显示"正在输入"状态
   * @param chatId 聊天/频道 ID
   */
  showTyping?(_chatId: string): Promise<void>;

  /**
   * 任务完成回调（由核心逻辑调用）
   * @param session 会话信息
   * @param response 响应内容
   */
  onTaskComplete(session: Session, response: IMResponse): Promise<void>;

  /**
   * 格式化响应消息为平台特定格式
   * @param response 核心逻辑的响应
   * @returns 平台特定的消息格式
   */
  formatMessage(response: IMResponse): IMMessageFormat;
}

/**
 * IM 适配器基类
 * 提供通用实现，各平台可继承并重写
 */
export abstract class BaseIMAdapter implements IMAdapter {
  abstract readonly platform: IMPlatform;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(
    _chatId: string,
    message: IMMessageFormat,
    options?: IMReplyOptions
  ): Promise<string>;

  abstract sendReply(_chatId: string, _messageId: string | undefined, message: IMMessageFormat): Promise<string>;

  abstract onTaskComplete(session: Session, response: IMResponse): Promise<void>;

  // 可选方法的默认实现
  async updateMessage?(
    chatId: string,
    _messageId: string,
    message: IMMessageFormat
  ): Promise<void> {
    // 默认不支持更新，直接发送新消息
    await this.sendMessage(chatId, message);
  }

  async addReaction?(_chatId: string, _messageId: string, _reaction: string): Promise<void> {
    // 默认空实现（平台不支持 reaction）
  }

  async showTyping?(_chatId: string): Promise<void> {
    // 默认空实现
  }

  /**
   * 默认消息格式化
   * 子类可重写以实现平台特定的格式
   */
  formatMessage(response: IMResponse): IMMessageFormat {
    return {
      text: response.message,
    };
  }
}
