// Baton 核心类型定义

import type { ACPClient } from './acp/client';

export interface Session {
  id: string;
  userId: string;
  projectPath: string;
  acpClient: ACPClient | null;
  queue: TaskQueue;
  isProcessing: boolean;
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
}

export interface IMResponse {
  success: boolean;
  message: string;
  data?: any;
}

export type CommandType = 
  | 'repo' 
  | 'current' 
  | 'stop' 
  | 'reset' 
  | 'mode' 
  | 'help'
  | 'prompt';

export interface ParsedCommand {
  type: CommandType;
  args: string[];
  raw: string;
}
