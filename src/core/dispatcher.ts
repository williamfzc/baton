import type { IMMessage, IMResponse, ParsedCommand } from '../types';
import { SessionManager } from './session';
import { TaskQueueEngine } from './queue';

export class CommandDispatcher {
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;

  constructor(projectPath: string) {
    this.sessionManager = new SessionManager(projectPath);
    this.queueEngine = new TaskQueueEngine();
  }

  parseCommand(text: string): ParsedCommand {
    const trimmed = text.trim();
    
    // System Meta Commands (优先级最高)
    if (trimmed.startsWith('/repo')) {
      return { type: 'repo', args: trimmed.split(' ').slice(1), raw: trimmed };
    }
    if (trimmed === '/current') {
      return { type: 'current', args: [], raw: trimmed };
    }
    if (trimmed.startsWith('/stop')) {
      return { type: 'stop', args: trimmed.split(' ').slice(1), raw: trimmed };
    }
    if (trimmed === '/reset') {
      return { type: 'reset', args: [], raw: trimmed };
    }
    if (trimmed.startsWith('/mode')) {
      return { type: 'mode', args: trimmed.split(' ').slice(1), raw: trimmed };
    }
    if (trimmed === '/help') {
      return { type: 'help', args: [], raw: trimmed };
    }

    // 默认作为 prompt 处理
    return { type: 'prompt', args: [trimmed], raw: trimmed };
  }

  async dispatch(message: IMMessage): Promise<IMResponse> {
    const command = this.parseCommand(message.text);
    console.log(`[Dispatcher] ${message.userId}: ${command.type} - ${command.raw.substring(0, 30)}`);

    switch (command.type) {
      case 'repo':
        return this.handleRepo(message, command);
      
      case 'current':
        return this.handleCurrent(message);
      
      case 'stop':
        return this.handleStop(message, command);
      
      case 'reset':
        return this.handleReset(message);
      
      case 'mode':
        return this.handleMode(message, command);
      
      case 'help':
        return this.handleHelp();
      
      case 'prompt':
      default:
        return this.handlePrompt(message, command);
    }
  }

  private async handleRepo(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    // MVP 只支持单项目，列出当前项目
    return {
      success: true,
      message: `Current project: ${process.cwd()}\n\nNote: MVP only supports single project mode.`
    };
  }

  private handleCurrent(message: IMMessage): IMResponse {
    return this.sessionManager.getQueueStatus(message.userId);
  }

  private async handleStop(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    const target = command.args[0];
    return this.sessionManager.stopTask(message.userId, target);
  }

  private async handleReset(message: IMMessage): Promise<IMResponse> {
    return this.sessionManager.resetSession(message.userId);
  }

  private handleMode(message: IMMessage, command: ParsedCommand): IMResponse {
    const mode = command.args[0] || 'default';
    return {
      success: true,
      message: `Mode switched to: ${mode}\n\n(Note: Mode switching will be fully implemented in future versions)`
    };
  }

  private handleHelp(): IMResponse {
    const helpText = `
**Baton Commands:**

*System Commands:*
- /current - Show current session status
- /stop [id/all] - Stop current task or clear queue
- /reset - Reset session (kill agent, clear context)
- /mode [mode_name] - Switch agent mode
- /help - Show this help

*Agent Interaction:*
- Type any text to send as prompt to agent
- All non-command text will be forwarded to the AI agent

*Permission:*
- All file/tool operations are auto-approved in MVP
- Interactive confirmation will be added in future versions
    `.trim();

    return {
      success: true,
      message: helpText
    };
  }

  private async handlePrompt(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    // 获取或创建会话
    const session = await this.sessionManager.getOrCreateSession(message.userId);
    
    // 加入任务队列
    const result = await this.queueEngine.enqueue(
      session,
      command.raw,
      'prompt'
    );

    return result;
  }
}
