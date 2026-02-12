/**
 * ACP 协议客户端
 * 封装与本地 ACP Agent（如 opencode）的通信，管理子进程生命周期
 * 实现 Agent Client Protocol 标准，提供标准化的 AI Agent 接入能力
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { IMResponse } from '../types';
import { createLogger } from '../utils/logger';
import * as acp from '@agentclientprotocol/sdk';
import type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  ReleaseTerminalRequest,
  KillTerminalCommandRequest,
  StopReason,
  Client,
  PermissionOption,
  SessionMode,
  ModelInfo,
} from '@agentclientprotocol/sdk';

const logger = createLogger('ACPClient');

// 权限处理回调类型
export type PermissionHandler = (params: RequestPermissionRequest) => Promise<string>;
export interface ACPLaunchConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ACPPlanEntry {
  status: string;
  content: string;
}

export interface ACPPlanStatus {
  entries: ACPPlanEntry[];
  updatedAt: number;
  summary: string;
  counts: {
    total: number;
    completed: number;
    inProgress: number;
    pending: number;
    other: number;
  };
  current?: ACPPlanEntry;
}

/**
 * 扩展的 ACP 会话状态
 * 包含处于 ACP 标准扩展阶段的模型信息
 */

// 实现 ACP Client 接口
class BatonClient implements Client {
  private messageBuffer: string[] = [];
  private responsePromise: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  } | null = null;
  private permissionHandler: PermissionHandler;
  private terminals: Map<string, { process: ChildProcessWithoutNullStreams; output: string[] }> =
    new Map();

  // 状态跟踪
  public availableModes: SessionMode[] = [];
  public currentModeId?: string;
  public availableModels: ModelInfo[] = [];
  public currentModelId?: string;
  private latestPlanEntries: ACPPlanEntry[] = [];
  private latestPlanUpdatedAt: number | null = null;

  constructor(permissionHandler: PermissionHandler) {
    this.permissionHandler = permissionHandler;
  }

  // 处理会话更新（agent 发来的消息）
  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.messageBuffer.push(update.content.text);
        }
        break;

      case 'tool_call':
        logger.info(`[ACP] Tool call: ${update.title} (${update.status})`);
        break;

      case 'tool_call_update':
        logger.info(`[ACP] Tool ${update.toolCallId} updated: ${update.status}`);
        break;

      case 'plan': {
        this.latestPlanEntries = update.entries.map(entry => ({
          status: String(entry.status || 'pending'),
          content: String(entry.content || ''),
        }));
        this.latestPlanUpdatedAt = Date.now();
        const planSummary = update.entries.map(e => `[${e.status}] ${e.content}`).join('\n');
        logger.info(`[ACP] Plan updated:\n${planSummary || 'Agent is planning...'}`);
        break;
      }

      case 'current_mode_update':
        this.currentModeId = update.currentModeId;
        logger.info(`[ACP] Mode updated to: ${update.currentModeId}`);
        break;

      case 'agent_thought_chunk':
      case 'user_message_chunk':
      case 'available_commands_update':
      case 'config_option_update':
      case 'session_info_update':
      case 'usage_update':
        // 这些更新在 MVP 中忽略
        break;

      default:
        break;
    }
  }

  // 权限请求（调用外部处理器）
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    logger.info(`[ACP] Permission requested: ${params.toolCall.title}`);

    // 调用外部回调，等待用户确认并选择选项
    try {
      const selectedOptionId = await this.permissionHandler(params);

      // 验证选择的 ID 是否在选项列表中
      const isValid = params.options.some(o => o.optionId === selectedOptionId);

      return {
        outcome: {
          outcome: 'selected',
          optionId: isValid ? selectedOptionId : params.options[0]?.optionId || 'deny',
        },
      };
    } catch (error: unknown) {
      logger.error(error as Error, 'Permission handler error');
      // 默认选择第一个拒绝选项或 fallback
      const fallbackOption =
        params.options.find((o: PermissionOption) => o.name.toLowerCase().includes('deny'))
          ?.optionId ||
        params.options[0]?.optionId ||
        'deny';
      return {
        outcome: {
          outcome: 'selected',
          optionId: fallbackOption,
        },
      };
    }
  }

  // 读取文件（受限访问）
  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const targetPath = String(params.path);
    // 路径安全检查
    const resolvedPath = path.resolve(targetPath);
    const projectRoot = process.cwd();

    if (!resolvedPath.startsWith(projectRoot)) {
      throw new Error('Access denied: path outside project root');
    }

    const content = await fs.readFile(resolvedPath, 'utf-8');
    return { content };
  }

  // 文件写入
  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const targetPath = String(params.path);
    const content = String(params.content);
    // 路径安全检查
    const resolvedPath = path.resolve(targetPath);
    const projectRoot = process.cwd();

    if (!resolvedPath.startsWith(projectRoot)) {
      throw new Error('Access denied: path outside project root');
    }

    await fs.writeFile(resolvedPath, content, 'utf-8');
    return {};
  }

  // 终端支持：创建终端
  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const commandStr = `${params.command} ${params.args?.join(' ') || ''}`.trim();

    logger.info({ terminalId, command: commandStr }, 'Creating terminal');

    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (params.env) {
      Object.assign(spawnEnv, params.env);
    }

    const proc = spawn(params.command, params.args || [], {
      cwd: params.cwd || process.cwd(),
      env: spawnEnv,
      shell: true,
    });

    const terminalData = {
      process: proc,
      output: [] as string[],
    };

    proc.stdout.on('data', (data: Buffer) => terminalData.output.push(data.toString()));
    proc.stderr.on('data', (data: Buffer) => terminalData.output.push(data.toString()));

    this.terminals.set(terminalId, terminalData);

    return { terminalId };
  }

  // 获取终端输出
  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) throw new Error('Terminal not found');

    const output = terminal.output.join('');
    terminal.output = []; // 模拟流，读取后清除

    return {
      output,
      truncated: false,
      exitStatus:
        terminal.process.exitCode !== null ? { exitCode: terminal.process.exitCode } : undefined,
    };
  }

  // 等待终端退出
  async waitForTerminalExit(
    params: WaitForTerminalExitRequest
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) throw new Error('Terminal not found');

    return new Promise(resolve => {
      if (terminal.process.exitCode !== null) {
        resolve({
          exitCode: terminal.process.exitCode,
        });
      } else {
        terminal.process.on('exit', (code, signal) => {
          resolve({
            exitCode: code ?? undefined,
            signal: signal ?? undefined,
          });
        });
      }
    });
  }

  // 释放终端
  async releaseTerminal(params: ReleaseTerminalRequest): Promise<void> {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal) {
      if (terminal.process.exitCode === null) {
        terminal.process.kill();
      }
      this.terminals.delete(params.terminalId);
    }
  }

  // 强杀终端命令
  async killTerminal(params: KillTerminalCommandRequest): Promise<void> {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal && terminal.process.exitCode === null) {
      terminal.process.kill('SIGTERM');
    }
  }

  // 等待完整响应
  async waitForResponse(timeout: number = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const partial = this.messageBuffer.join('');
        this.messageBuffer = [];
        this.responsePromise = null;
        resolve(partial || '[Response timeout]');
      }, timeout);

      this.responsePromise = {
        resolve: (value: string) => {
          clearTimeout(timer);
          this.responsePromise = null;
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.responsePromise = null;
          reject(error);
        },
      };
    });
  }

  // 标记响应完成
  onPromptComplete(stopReason: StopReason): void {
    if (this.responsePromise) {
      const fullResponse = this.messageBuffer.join('');
      this.messageBuffer = [];
      this.responsePromise.resolve(fullResponse || `[Completed: ${stopReason}]`);
    }
  }

  getPlanStatus(): ACPPlanStatus | null {
    if (!this.latestPlanUpdatedAt) {
      return null;
    }

    const counts = {
      total: this.latestPlanEntries.length,
      completed: 0,
      inProgress: 0,
      pending: 0,
      other: 0,
    };

    for (const entry of this.latestPlanEntries) {
      const normalized = entry.status.toLowerCase();
      if (normalized === 'completed' || normalized === 'done') {
        counts.completed += 1;
      } else if (
        normalized === 'in_progress' ||
        normalized === 'in-progress' ||
        normalized === 'running' ||
        normalized === 'active'
      ) {
        counts.inProgress += 1;
      } else if (
        normalized === 'pending' ||
        normalized === 'todo' ||
        normalized === 'not_started' ||
        normalized === 'not-started'
      ) {
        counts.pending += 1;
      } else {
        counts.other += 1;
      }
    }

    const current = this.latestPlanEntries.find(entry => {
      const normalized = entry.status.toLowerCase();
      return (
        normalized === 'in_progress' ||
        normalized === 'in-progress' ||
        normalized === 'running' ||
        normalized === 'active'
      );
    });

    return {
      entries: [...this.latestPlanEntries],
      updatedAt: this.latestPlanUpdatedAt,
      counts,
      current,
      summary: `总计 ${counts.total} 步，完成 ${counts.completed}，进行中 ${counts.inProgress}，待处理 ${counts.pending}`,
    };
  }
}

export class ACPClient {
  private projectPath: string;
  private agentProcess: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private batonClient: BatonClient;
  private currentSessionId: string | null = null;
  private executor: string;
  private launchConfig?: ACPLaunchConfig;

  constructor(
    projectPath: string,
    permissionHandler: PermissionHandler,
    executor: string = 'opencode',
    launchConfig?: ACPLaunchConfig
  ) {
    this.projectPath = projectPath;
    this.batonClient = new BatonClient(permissionHandler);
    this.executor = executor;
    this.launchConfig = launchConfig;
  }

  async startAgent(): Promise<void> {
    // 优先使用显式配置的自定义命令，否则根据 executor 类型确定启动命令
    let command: string;
    let args: string[];
    let cwd = this.projectPath;
    let env: Record<string, string | undefined> = process.env;

    if (this.launchConfig?.command) {
      command = this.launchConfig.command;
      args = this.launchConfig.args || [];
      if (this.launchConfig.cwd) {
        cwd = path.isAbsolute(this.launchConfig.cwd)
          ? this.launchConfig.cwd
          : path.resolve(this.projectPath, this.launchConfig.cwd);
      }
      if (this.launchConfig.env) {
        env = { ...process.env, ...this.launchConfig.env };
      }
    } else {
      switch (this.executor) {
        case 'claude-code':
          command = 'claude-code-acp';
          args = [];
          break;
        case 'codex':
          command = 'codex-acp';
          args = [];
          break;
        case 'opencode':
        default:
          command = 'opencode';
          args = ['acp'];
          break;
      }
    }

    logger.info(`[ACP] Starting ${this.executor} (${command} ${args.join(' ')}) in ${cwd}`);

    // 启动 ACP 进程
    this.agentProcess = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.agentProcess.pid) {
      throw new Error('Failed to start agent process');
    }
    const pid = this.agentProcess.pid;
    logger.info(`[ACP] Agent started with PID: ${pid}`);

    // 创建流
    if (!this.agentProcess.stdin || !this.agentProcess.stdout) {
      throw new Error('Failed to initialize agent streams');
    }
    const input = Writable.toWeb(this.agentProcess.stdin) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(
      this.agentProcess.stdout
    ) as unknown as ReadableStream<Uint8Array>;

    // 创建 ACP 流
    const stream = acp.ndJsonStream(input, output);

    // 创建客户端连接
    this.connection = new acp.ClientSideConnection(() => this.batonClient, stream);

    // 初始化连接
    logger.info('[ACP] Initializing connection...');
    const initResult = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    });

    logger.info(`[ACP] Connected (protocol v${initResult.protocolVersion})`);

    // 创建新会话
    logger.info('[ACP] Creating new session...');
    const sessionResult = await this.connection.newSession({
      cwd: this.projectPath,
      mcpServers: [],
    });

    const sessionResultWithSessionId = sessionResult as { sessionId: string };
    this.currentSessionId = sessionResultWithSessionId.sessionId;

    // 捕获初始模式和模型
    if (sessionResult.modes) {
      this.batonClient.availableModes = sessionResult.modes.availableModes;
      this.batonClient.currentModeId = sessionResult.modes.currentModeId;
    }
    if (sessionResult.models) {
      this.batonClient.availableModels = sessionResult.models.availableModels;
      this.batonClient.currentModelId = sessionResult.models.currentModelId;
    }

    logger.info(`[ACP] Session created: ${sessionResult.sessionId}`);
  }

  async stop(): Promise<void> {
    logger.info(`[ACP] Stopping agent`);

    if (this.agentProcess) {
      this.agentProcess.kill();
      this.agentProcess = null;
    }

    this.connection = null;
    this.currentSessionId = null;

    logger.info(`[ACP] Agent stopped.`);
  }

  // 获取 Agent 进程状态
  getAgentStatus(): { pid: number | undefined; running: boolean } {
    if (!this.agentProcess) {
      return { pid: undefined, running: false };
    }

    const pid = this.agentProcess.pid;
    const running = this.agentProcess.exitCode === null;

    return { pid, running };
  }

  async sendPrompt(prompt: string): Promise<IMResponse> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error('Agent not initialized');
    }

    logger.info(`[ACP] Sending prompt: ${prompt.substring(0, 50)}...`);

    // 启动等待响应
    const responsePromise = this.batonClient.waitForResponse();

    // 发送 prompt
    const promptResult = await this.connection.prompt({
      sessionId: this.currentSessionId,
      prompt: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    });

    // Prompt 完成，触发响应
    this.batonClient.onPromptComplete(promptResult.stopReason);

    // 等待完整响应
    const response = await responsePromise;

    return {
      success: true,
      message: response || `[Completed: ${promptResult.stopReason}]`,
    };
  }

  async sendCommand(command: string): Promise<IMResponse> {
    // 命令透传，与 prompt 类似
    return this.sendPrompt(command);
  }

  async cancelCurrentTask(): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      return;
    }

    logger.info('[ACP] Cancelling current task...');

    // 发送 cancel 通知
    await this.connection.cancel({
      sessionId: this.currentSessionId,
    });

    // 终止等待
    if (this.batonClient) {
      this.batonClient.onPromptComplete('cancelled');
    }
  }

  // 获取模式/模型状态
  getModeState() {
    return {
      availableModes: this.batonClient.availableModes,
      currentModeId: this.batonClient.currentModeId,
    };
  }

  getModelState() {
    return {
      availableModels: this.batonClient.availableModels,
      currentModelId: this.batonClient.currentModelId,
    };
  }

  getPlanStatus(): ACPPlanStatus | null {
    return this.batonClient.getPlanStatus();
  }

  // 设置模式/模型
  async setMode(modeId: string): Promise<IMResponse> {
    if (!this.connection || !this.currentSessionId) throw new Error('Not connected');

    // 检查连接是否支持 setSessionMode 方法
    if (
      'setSessionMode' in this.connection &&
      typeof this.connection.setSessionMode === 'function'
    ) {
      await this.connection.setSessionMode({
        sessionId: this.currentSessionId,
        modeId,
      });
    } else {
      return {
        success: false,
        message: '当前 Agent 不支持模式切换功能',
      };
    }

    return { success: true, message: `模式已切换为: ${modeId}` };
  }

  async setModel(modelId: string): Promise<IMResponse> {
    if (!this.connection || !this.currentSessionId) throw new Error('Not connected');

    // 检查连接是否支持 setSessionModel 方法
    if (
      'setSessionModel' in this.connection &&
      typeof this.connection.setSessionModel === 'function'
    ) {
      await this.connection.setSessionModel({
        sessionId: this.currentSessionId,
        modelId,
      });
    } else {
      // 如果没有标准方法，尝试使用通用 execute 方法
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const conn = this.connection as unknown as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (typeof conn.execute === 'function') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          await (conn.execute as (method: string, params: unknown) => Promise<unknown>)(
            'session/setModel',
            {
              sessionId: this.currentSessionId,
              modelId,
            }
          );
        } catch {
          // 如果 execute 也失败，返回不支持的信息
          return {
            success: false,
            message: '当前 Agent 不支持模型切换功能',
          };
        }
      } else {
        // 连接不支持模型切换，返回友好提示
        return {
          success: false,
          message: '当前 Agent 不支持模型切换功能',
        };
      }
    }

    return { success: true, message: `模型已切换为: ${modelId}` };
  }
}
