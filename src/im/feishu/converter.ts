import type { UniversalCard, CardElement, CardAction } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeishuCard = Record<string, any>;

/**
 * 将通用卡片转换为飞书交互式卡片格式
 * 文档: https://open.feishu.cn/document/ukTMukTMukTM/uEjNwYjLxYDM24SM2AjN
 */
export function convertToFeishuCard(card: UniversalCard): FeishuCard {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: any[] = [];

  const feishuCard: FeishuCard = {
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: card.title,
      },
      template: 'blue', // 默认使用蓝色标题
    },
    elements,
  };

  // 转换内容元素
  for (const element of card.elements) {
    const feishuElement = convertElement(element);
    if (feishuElement) {
      elements.push(feishuElement);
    }
  }

  // 转换操作按钮
  if (card.actions && card.actions.length > 0) {
    const actionElement = {
      tag: 'action',
      actions: card.actions.map(convertAction),
    };
    elements.push(actionElement);
  }

  return feishuCard;
}

function convertElement(element: CardElement): FeishuCard | null {
  switch (element.type) {
    case 'markdown':
      return {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: element.content,
        },
      };

    case 'text':
      return {
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: element.content,
        },
      };

    case 'field_group':
      return {
        tag: 'div',
        fields: element.fields.map(field => ({
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**${field.title}**\n${field.content}`,
          },
        })),
      };

    case 'hr':
      return {
        tag: 'hr',
      };

    case 'picker':
      // 飞书使用 select_static 作为选择器
      return {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${element.title}**`,
        },
      };

    default:
      return null;
  }
}

function convertAction(action: CardAction): FeishuCard {
  const button: FeishuCard = {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: action.text,
    },
    type: mapButtonStyle(action.style),
    value: {
      action_id: action.id, // 飞书回传的 action_id (注意：飞书通常放在 value 字典里)
      value: action.value, // 实际数据
    },
  };

  if (action.confirm) {
    button.confirm = {
      title: {
        tag: 'plain_text',
        content: action.confirm.title,
      },
      text: {
        tag: 'plain_text',
        content: action.confirm.content,
      },
    };
  }

  return button;
}

function mapButtonStyle(style: CardAction['style']): string {
  switch (style) {
    case 'primary':
      return 'primary';
    case 'danger':
      return 'danger';
    case 'default':
    default:
      return 'default';
  }
}
