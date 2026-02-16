import enCommon from './locales/en/common.js';
import enCli from './locales/en/cli.js';
import enServer from './locales/en/server.js';
import enMain from './locales/en/main.js';
import enIm from './locales/en/im.js';
import enCore from './locales/en/core.js';
import zhCNCommon from './locales/zh-CN/common.js';
import zhCNCli from './locales/zh-CN/cli.js';
import zhCNServer from './locales/zh-CN/server.js';
import zhCNMain from './locales/zh-CN/main.js';
import zhCNIm from './locales/zh-CN/im.js';
import zhCNCore from './locales/zh-CN/core.js';

export type Locale = 'en' | 'zh-CN';
export type Namespace = 'common' | 'cli' | 'server' | 'main' | 'im' | 'core';

type ResourceBundle = Partial<Record<Namespace, Record<string, string>>>;
export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh-CN'];

const resources: Record<Locale, ResourceBundle> = {
  en: {
    common: enCommon,
    cli: enCli,
    server: enServer,
    main: enMain,
    im: enIm,
    core: enCore,
  },
  'zh-CN': {
    common: zhCNCommon,
    cli: zhCNCli,
    server: zhCNServer,
    main: zhCNMain,
    im: zhCNIm,
    core: zhCNCore,
  },
};

let currentLocale: Locale = 'en';
let fallbackLocale: Locale = 'en';

export function initI18n(options?: { defaultLocale?: Locale; fallbackLocale?: Locale }) {
  if (options?.defaultLocale) {
    currentLocale = options.defaultLocale;
  }
  if (options?.fallbackLocale) {
    fallbackLocale = options.fallbackLocale;
  }
  return { locale: currentLocale, fallbackLocale };
}

export function resolveLocale(input?: string): Locale {
  if (!input) return 'en';
  return SUPPORTED_LOCALES.includes(input as Locale) ? (input as Locale) : 'en';
}

export function setLocale(locale: Locale) {
  currentLocale = locale;
}

export function getLocale() {
  return currentLocale;
}

export function t(namespace: Namespace, key: string) {
  const localesToTry: Locale[] = [currentLocale, fallbackLocale];
  for (const locale of localesToTry) {
    const directValue = resources[locale]?.[namespace]?.[key];
    if (directValue) {
      return directValue;
    }
    if (namespace !== 'common') {
      const commonValue = resources[locale]?.common?.[key];
      if (commonValue) {
        return commonValue;
      }
    }
  }
  return key;
}

export function listNamespaces(locale: Locale = currentLocale) {
  return Object.keys(resources[locale] || {}) as Namespace[];
}
