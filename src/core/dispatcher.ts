/**
 * 指令分发器
 * 解析用户输入，区分系统指令和 Agent Prompt，路由到相应的处理逻辑
 * 作为 IM 层和核心逻辑层的桥梁，统一处理所有用户请求
 * 支持 /repo 命令切换不同仓库，每个仓库有独立的会话
 */
import type { IMMessage, IMResponse, ParsedCommand } from '../types';
import type { UniversalCard } from '../im/types';
import type { SessionManager } from './session';
import type { TaskQueueEngine } from './queue';

export class CommandDispatcher {
  private sessionManager: SessionManager;
  private queueEngine: TaskQueueEngine;

  constructor(sessionManager: SessionManager, queueEngine: TaskQueueEngine) {
    this.sessionManager = sessionManager;
    this.queueEngine = queueEngine;
  }

  parseCommand(text: string): ParsedCommand {
    const trimmed = text.trim();

    // System Meta Commands (优先级最高)
    if (trimmed.startsWith('/repo')) {
      return { type: 'repo', args: trimmed.split(' ').slice(1), raw: trimmed };
    }
    if (trimmed.startsWith('/current')) {
      return { type: 'current', args: [], raw: trimmed };
    }
    if (trimmed.startsWith('/stop')) {
      return { type: 'stop', args: trimmed.split(' ').slice(1), raw: trimmed };
    }
    if (trimmed.startsWith('/reset')) {
      return { type: 'reset', args: [], raw: trimmed };
    }
    if (trimmed.startsWith('/model')) {
      return { type: 'model', args: trimmed.split(' ').slice(1), raw: trimmed };
    }
    if (trimmed.startsWith('/mode')) {
      return { type: 'mode', args: trimmed.split(' ').slice(1), raw: trimmed };
    }
    if (trimmed.startsWith('/help')) {
      return { type: 'help', args: [], raw: trimmed };
    }

    // Agent Passthrough (其他以 / 开头的)
    return { type: 'prompt', args: [trimmed], raw: trimmed };
  }

  async dispatch(message: IMMessage): Promise<IMResponse> {
    const trimmed = message.text.trim();
    const command = this.parseCommand(message.text);

    // 💡 统一处理：如果当前有待处理的交互（权限、选择等）
    const currentRepo = this.sessionManager.getCurrentRepo();
    const projectPath = currentRepo?.path || '';
    const session = await this.sessionManager.getOrCreateSession(
      message.userId,
      message.contextId,
      projectPath
    );
    if (session.pendingInteractions.size > 0) {
      // 如果输入是纯数字，则视为选择选项
      if (/^\d+$/.test(trimmed)) {
        // 取第一个挂起的请求
        const requestId = Array.from(session.pendingInteractions.keys())[0];
        const interaction = session.pendingInteractions.get(requestId);
        console.log(
          `[Dispatcher] Numeric input detected during pending ${interaction?.type}. Treating as selection.`
        );
        return this.sessionManager.resolveInteraction(session.id, requestId, trimmed);
      } else if (command.type === 'mode' || command.type === 'model') {
        // 如果是 mode 或 model 命令，提醒用户先处理当前交互
        console.log(`[Dispatcher] Mode/Model command detected during pending interaction.`);
        return {
          success: false,
          message:
            '当前有待处理的选择，请先完成选择后再试。\n请使用数字序号回复或点击 IM 卡片进行选择。',
        };
      }
    }

    console.log(
      `[Dispatcher] ${message.userId}: ${command.type} - ${command.raw.substring(0, 30)}`
    );

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

      case 'model':
        return this.handleModel(message, command);

      case 'help':
        return this.handleHelp();

      case 'prompt':
      default:
        return this.handlePrompt(message, command);
    }
  }

  private async handleRepo(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    const repoManager = this.sessionManager.getRepoManager();
    if (!repoManager) {
      return {
        success: false,
        message: '仓库管理器未初始化',
        card: this.createErrorCard('仓库管理器未初始化'),
      };
    }

    const repos = repoManager.listRepos();
    if (repos.length === 0) {
      return {
        success: true,
        message: '未发现任何 Git 仓库',
        card: {
          title: '📦 仓库列表',
          elements: [
            {
              type: 'markdown',
              content: '未在指定目录下发现任何 Git 仓库',
            },
          ],
        },
      };
    }

    const identifier = command.args[0]?.trim();

    if (!identifier) {
      // 创建仓库选择交互
      return this.sessionManager.createRepoSelection(message.userId, message.contextId, repos);
    }

    const targetRepo = repoManager.findRepo(identifier);
    if (!targetRepo) {
      return {
        success: false,
        message: `未找到仓库: ${identifier}`,
        card: this.createErrorCard(`未找到仓库: ${identifier}`),
      };
    }

    const currentRepo = this.sessionManager.getCurrentRepo();
    if (currentRepo && currentRepo.path === targetRepo.path) {
      return {
        success: true,
        message: `当前已在仓库: ${targetRepo.name}`,
        card: {
          title: '📦 仓库切换',
          elements: [
            {
              type: 'markdown',
              content: `ℹ️ 当前已在仓库：**${targetRepo.name}**`,
            },
            {
              type: 'markdown',
              content: `📂 路径: \`${targetRepo.path}\``,
            },
          ],
        },
      };
    }

    await this.sessionManager.resetAllSessions();
    this.sessionManager.setCurrentRepo(targetRepo);

    return {
      success: true,
      message: `🔄 已切换到仓库: ${targetRepo.name}`,
      data: { repo: { name: targetRepo.name, path: targetRepo.path } },
      card: {
        title: '📦 仓库切换成功',
        elements: [
          {
            type: 'markdown',
            content: `✅ 已切换到仓库：**${targetRepo.name}**`,
          },
          {
            type: 'markdown',
            content: `📂 路径: \`${targetRepo.path}\``,
          },
          {
            type: 'markdown',
            content: '💡 新的会话将在下次发送消息时自动创建',
          },
        ],
      },
    };
  }

  // 辅助方法：创建错误卡片
  private createErrorCard(message: string): UniversalCard {
    return {
      title: '❌ 操作失败',
      elements: [
        {
          type: 'markdown',
          content: message,
        },
      ],
    };
  }

  private handleCurrent(message: IMMessage): IMResponse {
    return this.sessionManager.getQueueStatus(message.userId, message.contextId);
  }

  private async handleStop(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    const target = command.args[0];
    return this.sessionManager.stopTask(message.userId, target, message.contextId);
  }

  private async handleReset(message: IMMessage): Promise<IMResponse> {
    return this.sessionManager.resetSession(message.userId, message.contextId);
  }

  private async handleMode(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    const mode = command.args[0];
    if (mode) {
      // 直接切换
      const projectPath = this.sessionManager.getCurrentRepo()?.path || '';
      const session = await this.sessionManager.getOrCreateSession(
        message.userId,
        message.contextId,
        projectPath
      );
      if (session.acpClient) {
        const result = await session.acpClient.setMode(mode);
        // 添加卡片格式
        return {
          ...result,
          card: result.success
            ? {
                title: '🎨 模式切换',
                elements: [
                  {
                    type: 'markdown' as const,
                    content: `✅ **模式已切换为：** \`${mode}\``,
                  },
                ],
              }
            : this.createErrorCard(result.message),
        };
      }
      return {
        success: false,
        message: 'Agent 未启动',
        card: this.createErrorCard('Agent 未启动'),
      };
    }
    // 触发选择界面
    return this.sessionManager.triggerModeSelection(message.userId, message.contextId);
  }

  private async handleModel(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    const model = command.args[0];
    if (model) {
      // 直接切换
      const projectPath = this.sessionManager.getCurrentRepo()?.path || '';
      const session = await this.sessionManager.getOrCreateSession(
        message.userId,
        message.contextId,
        projectPath
      );
      if (session.acpClient) {
        const result = await session.acpClient.setModel(model);
        // 添加卡片格式
        return {
          ...result,
          card: result.success
            ? {
                title: '🤖 模型切换',
                elements: [
                  {
                    type: 'markdown' as const,
                    content: `✅ **模型已切换为：** \`${model}\``,
                  },
                ],
              }
            : this.createErrorCard(result.message),
        };
      }
      return {
        success: false,
        message: 'Agent 未启动',
        card: this.createErrorCard('Agent 未启动'),
      };
    }
    // 触发选择界面
    return this.sessionManager.triggerModelSelection(message.userId, message.contextId);
  }

  private handleHelp(): IMResponse {
    const helpCard: UniversalCard = {
      title: '📚 Baton 指令帮助',
      elements: [
        {
          type: 'markdown',
          content: '**🔧 系统指令**',
        },
        {
          type: 'markdown',
          content: `
• \`/repo [序号/名称]\` - 查看或切换仓库
• \`/current\` - 查看当前会话状态
• \`/stop [id/all]\` - 停止当前任务或清空队列
• \`/reset\` - 重置会话（清除上下文）
• \`/mode [name]\` - 查看或切换 Agent 模式
• \`/model [name]\` - 查看或切换 AI 模型
• \`/help\` - 显示此帮助
          `.trim(),
        },
        {
          type: 'hr',
        },
        {
          type: 'markdown',
          content: '**💬 Agent 交互**',
        },
        {
          type: 'markdown',
          content: `
• 发送任意文本即可与 AI Agent 对话
• 所有非指令文本都会转发给 Agent
          `.trim(),
        },
        {
          type: 'hr',
        },
        {
          type: 'markdown',
          content: '**⚡ 权限说明**',
        },
        {
          type: 'markdown',
          content: '敏感操作需用户确认，请使用数字序号回复或 IM 卡片进行交互',
        },
      ],
    };

    return {
      success: true,
      message: 'Baton 指令帮助已发送',
      card: helpCard,
    };
  }

  private async handlePrompt(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    // 获取或创建会话
    const projectPath = this.sessionManager.getCurrentRepo()?.path || '';
    const session = await this.sessionManager.getOrCreateSession(
      message.userId,
      message.contextId,
      projectPath
    );

    // 💡 隐式取消逻辑：如果当前有待处理的权限请求，说明用户可能想改需求
    // 发送新指令会自动取消当前的权限请求和任务
    if (session.pendingInteractions.size > 0) {
      console.log(
        `[Dispatcher] User sent new instruction while permission pending. Cancelling current task...`
      );
      await this.sessionManager.stopTask(message.userId, undefined, message.contextId);
      // 显式清理挂起的请求
      for (const [requestId] of session.pendingInteractions) {
        this.sessionManager.resolveInteraction(session.id, requestId, 'cancel');
      }
    }

    // 加入任务队列
    const result = await this.queueEngine.enqueue(session, command.raw, 'prompt');

    return result;
  }
}
