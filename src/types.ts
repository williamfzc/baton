/**
 * Baton 核心类型定义
 * 定义整个应用的基础数据结构和接口，包括会话、任务、消息等核心概念
 * 被所有模块共享，是整个项目的类型基础
 */

import type { ACPClient } from './acp/client';
import type { RequestPermissionRequest, SessionMode, ModelInfo } from '@agentclientprotocol/sdk';
import type { UniversalCard } from './im/types';

export type SessionState = 'IDLE' | 'RUNNING' | 'WAITING_CONFIRM' | 'STOPPED';

export interface Session {
  id: string;
  userId: string;
  contextId?: string;
  projectPath: string;
  repoName?: string;
  acpClient: ACPClient | null;
  queue: TaskQueue;
  isProcessing: boolean;
  state: SessionState;
  availableModes: SessionMode[];
  currentModeId?: string;
  availableModels: ModelInfo[];
  currentModelId?: string;
  // 统一的交互等待机制，支持权限请求、仓库选择、模式选择等
  pendingInteractions: Map<
    string,
    {
      type: 'permission' | 'repo_selection' | 'mode_selection' | 'model_selection';
      resolve: (value: string) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reject: (reason?: any) => void;
      timestamp: number;
      // 交互数据：权限请求时为 RequestPermissionRequest，选择时为选项列表
      data: {
        title?: string;
        options: { optionId: string; name: string }[];
        // 可选：原始请求对象（用于权限请求）
        originalRequest?: RequestPermissionRequest;
      };
    }
  >;
}

export interface Task {
  id: string;
  type: 'prompt' | 'command';
  content: string;
  timestamp: number;
}

export interface TaskQueue {
  pending: Task[];
  current: Task | null;
}

export interface IMMessage {
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
  contextId?: string;
}

export interface IMResponse {
  success: boolean;
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  card?: UniversalCard; // 卡片格式响应，优先使用
}

export type CommandType =
  | 'repo'
  | 'current'
  | 'stop'
  | 'reset'
  | 'mode'
  | 'model'
  | 'help'
  | 'prompt';

export interface ParsedCommand {
  type: CommandType;
  args: string[];
  raw: string;
}

export interface RepoInfo {
  name: string;
  path: string;
  gitPath: string;
}
