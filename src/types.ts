/**
 * Baton 核心类型定义
 * 定义整个应用的基础数据结构和接口，包括会话、任务、消息等核心概念
 * 被所有模块共享，是整个项目的类型基础
 */

import type { ACPClient } from './acp/client';
import type { RequestPermissionRequest, SessionMode, ModelInfo } from '@agentclientprotocol/sdk';

export interface Session {
  id: string;
  userId: string;
  projectPath: string;
  repoName?: string;
  acpClient: ACPClient | null;
  queue: TaskQueue;
  isProcessing: boolean;
  availableModes: SessionMode[];
  currentModeId?: string;
  availableModels: ModelInfo[];
  currentModelId?: string;
  pendingPermissions: Map<
    string,
    {
      resolve: (value: string) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reject: (reason?: any) => void;
      timestamp: number;
      request: RequestPermissionRequest; // 存储原始请求以获取选项列表
    }
  >;
  // 用于存储当前正在等待的用户输入类型
  waitingFor?: {
    type: 'repo_selection' | 'permission';
    timestamp: number;
  };
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
