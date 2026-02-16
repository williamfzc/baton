/**
 * 指令分发器
 * 负责控制平面（/repo /stop /reset 等）与数据平面（prompt 入队）的路由
 * 在 WAITING_CONFIRM 状态下优先处理确认消息，其余普通消息仅入队不抢占执行
 */
import type { IMMessage, IMResponse, ParsedCommand } from '../types';
import type { UniversalCard } from '../im/types';
import type { SessionManager } from './session';
import type { TaskQueueEngine } from './queue';
import { createLogger } from '../utils/logger';
import { t } from '../i18n';

const logger = createLogger('Dispatcher');

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
    if (/^\/(?:reset|new)(?:\s|$)/.test(trimmed)) {
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

    const projectPath = this.sessionManager.resolveProjectPath(message.userId, message.contextId);
    const session = await this.sessionManager.getOrCreateSession(
      message.userId,
      message.contextId,
      projectPath
    );

    if (session.pendingInteractions.size > 0 && command.type === 'prompt') {
      const interactionResponse = await this.sessionManager.tryResolveInteraction(
        session.id,
        trimmed
      );
      if (interactionResponse) {
        return interactionResponse;
      }
    }

    logger.info(
      { userId: message.userId, command: command.type, raw: command.raw.substring(0, 30) },
      'Dispatching message'
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
        message: t('core', 'repoManagerNotInitialized'),
        card: this.createErrorCard(t('core', 'repoManagerNotInitialized')),
      };
    }

    const repos = repoManager.listRepos();
    if (repos.length === 0) {
      return {
        success: true,
        message: t('core', 'repoEmptyMessage'),
        card: {
          title: t('core', 'repoListTitle'),
          elements: [
            {
              type: 'markdown',
              content: t('core', 'repoListEmpty'),
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
        message: `${t('core', 'repoNotFoundPrefix')}${identifier}`,
        card: this.createErrorCard(`${t('core', 'repoNotFoundPrefix')}${identifier}`),
      };
    }

    const currentRepo = this.sessionManager.getConversationRepo(message.userId, message.contextId);
    if (currentRepo && currentRepo.path === targetRepo.path) {
      return {
        success: true,
        message: `${t('core', 'repoAlreadyCurrentPrefix')}${targetRepo.name}`,
        card: {
          title: t('core', 'repoSwitchTitle'),
          elements: [
            {
              type: 'markdown',
              content: `${t('core', 'repoAlreadyCurrentCardPrefix')}${targetRepo.name}${t(
                'core',
                'repoAlreadyCurrentCardSuffix'
              )}`,
            },
            {
              type: 'markdown',
              content: `${t('core', 'repoPathLabel')}\`${targetRepo.path}\``,
            },
          ],
        },
      };
    }

    this.sessionManager.switchConversationRepo(message.userId, message.contextId, targetRepo);

    return {
      success: true,
      message: `${t('core', 'repoSwitchedPrefix')}${targetRepo.name}`,
      data: { repo: { name: targetRepo.name, path: targetRepo.path } },
      card: {
        title: t('core', 'repoSwitchSuccessTitle'),
        elements: [
          {
            type: 'markdown',
            content: `${t('core', 'repoSwitchSuccessCardPrefix')}${targetRepo.name}${t(
              'core',
              'repoSwitchSuccessCardSuffix'
            )}`,
          },
          {
            type: 'markdown',
            content: `${t('core', 'repoPathLabel')}\`${targetRepo.path}\``,
          },
          {
            type: 'markdown',
            content: t('core', 'repoSwitchSessionHint'),
          },
        ],
      },
    };
  }

  // 辅助方法：创建错误卡片
  private createErrorCard(message: string): UniversalCard {
    return {
      title: t('core', 'errorCardTitle'),
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
      const projectPath = this.sessionManager.resolveProjectPath(message.userId, message.contextId);
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
                title: t('core', 'modeSwitchTitle'),
                elements: [
                  {
                    type: 'markdown' as const,
                    content: `${t('core', 'modeSwitchedPrefix')}${mode}${t(
                      'core',
                      'modeSwitchedSuffix'
                    )}`,
                  },
                ],
              }
            : this.createErrorCard(result.message),
        };
      }
      return {
        success: false,
        message: t('core', 'agentNotStarted'),
        card: this.createErrorCard(t('core', 'agentNotStarted')),
      };
    }
    // 触发选择界面
    return this.sessionManager.triggerModeSelection(message.userId, message.contextId);
  }

  private async handleModel(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    const model = command.args[0];
    if (model) {
      // 直接切换
      const projectPath = this.sessionManager.resolveProjectPath(message.userId, message.contextId);
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
                title: t('core', 'modelSwitchTitle'),
                elements: [
                  {
                    type: 'markdown' as const,
                    content: `${t('core', 'modelSwitchedPrefix')}${model}${t(
                      'core',
                      'modelSwitchedSuffix'
                    )}`,
                  },
                ],
              }
            : this.createErrorCard(result.message),
        };
      }
      return {
        success: false,
        message: t('core', 'agentNotStarted'),
        card: this.createErrorCard(t('core', 'agentNotStarted')),
      };
    }
    // 触发选择界面
    return this.sessionManager.triggerModelSelection(message.userId, message.contextId);
  }

  private handleHelp(): IMResponse {
    const helpCard: UniversalCard = {
      title: t('core', 'helpCardTitle'),
      elements: [
        {
          type: 'markdown',
          content: t('core', 'helpSystemTitle'),
        },
        {
          type: 'markdown',
          content: t('core', 'helpSystemList'),
        },
        {
          type: 'hr',
        },
        {
          type: 'markdown',
          content: t('core', 'helpAgentTitle'),
        },
        {
          type: 'markdown',
          content: t('core', 'helpAgentList'),
        },
        {
          type: 'hr',
        },
        {
          type: 'markdown',
          content: t('core', 'helpPermissionTitle'),
        },
        {
          type: 'markdown',
          content: t('core', 'helpPermissionDesc'),
        },
      ],
    };

    return {
      success: true,
      message: t('core', 'helpMessageSent'),
      card: helpCard,
    };
  }

  private async handlePrompt(message: IMMessage, command: ParsedCommand): Promise<IMResponse> {
    // 获取或创建会话
    const projectPath = this.sessionManager.resolveProjectPath(message.userId, message.contextId);
    const session = await this.sessionManager.getOrCreateSession(
      message.userId,
      message.contextId,
      projectPath
    );

    // 加入任务队列
    const result = await this.queueEngine.enqueue(session, command.raw, 'prompt');

    return result;
  }
}
