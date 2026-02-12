/**
 * FakeACPClient - 内存中的 ACP 协议模拟器
 */
import type {
  SessionMode,
  ModelInfo,
  RequestPermissionRequest,
  PermissionOption,
} from '@agentclientprotocol/sdk';
import type { IMResponse } from '../../types';

export type PermissionHandler = (params: RequestPermissionRequest) => Promise<string>;

interface Terminal {
  id: string;
  command: string;
  output: string[];
  exitCode: number | null;
}

export interface FakePromptConfig {
  response?: string;
  stopReason?: 'completed' | 'cancelled' | 'error';
  triggerPermission?: {
    title: string;
    options: Array<{ optionId: string; name: string; kind: 'allow_once' }>;
  };
  createTerminal?: {
    command: string;
    args?: string[];
    output?: string[];
    exitCode?: number;
  };
  delay?: number;
}

const DEFAULT_CONFIG: Required<FakePromptConfig> = {
  response: '[FakeACP] 这是一个模拟的 Agent 响应',
  stopReason: 'completed',
  triggerPermission: undefined as never,
  createTerminal: undefined as never,
  delay: 0,
};

export class FakeACPClient {
  private permissionHandler: PermissionHandler;
  private terminals: Map<string, Terminal> = new Map();
  private terminalCounter = 0;

  public availableModes: SessionMode[] = [
    { id: 'general', name: 'General' },
    { id: 'coding', name: 'Coding' },
  ];
  public currentModeId?: string = 'general';
  public availableModels: ModelInfo[] = [
    { modelId: 'gpt-4', name: 'GPT-4' },
    { modelId: 'claude-3', name: 'Claude-3' },
  ];
  public currentModelId?: string = 'gpt-4';

  private promptConfig: FakePromptConfig = DEFAULT_CONFIG;
  public onPrompt?: (content: string) => void;

  constructor(permissionHandler?: PermissionHandler) {
    this.permissionHandler = permissionHandler || (() => Promise.resolve('deny'));
  }

  setPromptConfig(config: FakePromptConfig): void {
    this.promptConfig = { ...DEFAULT_CONFIG, ...config };
  }

  resetConfig(): void {
    this.promptConfig = DEFAULT_CONFIG;
  }

  clearTerminals(): void {
    this.terminals.clear();
    this.terminalCounter = 0;
  }

  async startAgent(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 10));
    this.currentModeId = 'general';
    this.currentModelId = 'gpt-4';
  }

  async stop(): Promise<void> {
    this.terminals.clear();
  }

  getAgentStatus(): { pid: number | undefined; running: boolean } {
    return { pid: undefined, running: true };
  }

  async sendPrompt(prompt: string): Promise<IMResponse> {
    if (this.onPrompt) {
      this.onPrompt(prompt);
    }

    if (this.promptConfig.delay && this.promptConfig.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.promptConfig.delay));
    }

    if (this.promptConfig.triggerPermission) {
      const options: PermissionOption[] = this.promptConfig.triggerPermission.options.map(o => ({
        optionId: o.optionId,
        name: o.name,
        kind: 'allow_once',
      }));

      const result = await this.permissionHandler({
        sessionId: 'fake-session',
        toolCall: { title: this.promptConfig.triggerPermission.title, toolCallId: 'fake' },
        options,
      });

      if (result.toLowerCase().includes('deny')) {
        return {
          success: false,
          message: `权限被拒绝: ${this.promptConfig.triggerPermission.title}`,
        };
      }
    }

    return { success: true, message: this.promptConfig.response || '[FakeACP] 响应' };
  }

  async sendCommand(command: string): Promise<IMResponse> {
    return this.sendPrompt(command);
  }

  async cancelCurrentTask(): Promise<void> {}

  getModeState() {
    return { availableModes: this.availableModes, currentModeId: this.currentModeId };
  }

  getModelState() {
    return { availableModels: this.availableModels, currentModelId: this.currentModelId };
  }

  async setMode(modeId: string): Promise<IMResponse> {
    const mode = this.availableModes.find(m => m.id === modeId);
    if (!mode) return { success: false, message: `未知模式: ${modeId}` };
    this.currentModeId = modeId;
    return { success: true, message: `模式已切换为: ${mode.name}` };
  }

  async setModel(modelId: string): Promise<IMResponse> {
    const model = this.availableModels.find(m => m.modelId === modelId);
    if (!model) return { success: false, message: `未知模型: ${modelId}` };
    this.currentModelId = modelId;
    return { success: true, message: `模型已切换为: ${model.name}` };
  }
}

export class FakeACPClientFactory {
  private defaultConfig: FakePromptConfig = DEFAULT_CONFIG;

  setDefaultConfig(config: FakePromptConfig): void {
    this.defaultConfig = { ...DEFAULT_CONFIG, ...config };
  }

  create(permissionHandler?: PermissionHandler): FakeACPClient {
    const client = new FakeACPClient(permissionHandler);
    client.setPromptConfig(this.defaultConfig);
    return client;
  }

  createWithPermissionRequest(
    title: string,
    options: Array<{ optionId: string; name: string; kind: 'allow_once' }>,
    _defaultOption: string = 'deny'
  ): { client: FakeACPClient; resolvePermission: (option: string) => void } {
    let resolvePermission!: (option: string) => void;
    const permissionPromise = new Promise<string>(resolve => {
      resolvePermission = resolve;
    });

    const client = new FakeACPClient(() => permissionPromise);
    client.setPromptConfig({ ...DEFAULT_CONFIG, triggerPermission: { title, options } });

    return { client, resolvePermission };
  }

  createWithCommand(command: string, output: string[], exitCode: number = 0): FakeACPClient {
    const client = new FakeACPClient();
    client.setPromptConfig({ ...DEFAULT_CONFIG, createTerminal: { command, output, exitCode } });
    return client;
  }
}
