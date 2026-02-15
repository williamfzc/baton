/**
 * IM 通用 UI 定义
 * 定义跨平台的通用卡片和交互元素结构
 */

export interface UniversalCard {
  title: string;
  elements: CardElement[];
  actions?: CardAction[]; // 底部全局操作按钮
}

export type CardElement =
  | { type: 'markdown'; content: string }
  | { type: 'text'; content: string }
  | { type: 'field_group'; fields: { title: string; content: string }[] }
  | { type: 'hr' } // 水平分割线
  | { type: 'picker'; title: string; options: PickerOption[] }; // 飞书选择框

export interface PickerOption {
  optionId: string;
  name: string;
}

export interface CardAction {
  id: string;
  text: string;
  style: 'primary' | 'danger' | 'default';
  value: string; // 回传给回调的数据
  confirm?: {
    // 二次确认弹窗
    title: string;
    content: string;
  };
}

export enum IMPlatform {
  CLI = 'cli',
  FEISHU = 'feishu',
  TELEGRAM = 'telegram',
  WHATSAPP = 'whatsapp',
  SLACK = 'slack',
  DISCORD = 'discord',
}
