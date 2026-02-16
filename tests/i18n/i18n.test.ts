import { describe, it, expect } from 'bun:test';
import { initI18n, resolveLocale, setLocale, t } from '../../src/i18n/index.js';

describe('i18n', () => {
  it('should resolve locale and fallback to en for invalid input', () => {
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('fr')).toBe('en');
  });

  it('should switch language output based on current locale', () => {
    initI18n({ defaultLocale: 'en', fallbackLocale: 'en' });
    setLocale('en');
    const enText = t('cli', 'inputHint');

    initI18n({ defaultLocale: 'zh-CN', fallbackLocale: 'en' });
    setLocale('zh-CN');
    const zhText = t('cli', 'inputHint');

    expect(enText).not.toBe(zhText);
  });

  it('should fallback to common namespace when key is missing in namespace', () => {
    initI18n({ defaultLocale: 'zh-CN', fallbackLocale: 'en' });
    setLocale('zh-CN');
    expect(t('cli', 'appName')).toBe(t('common', 'appName'));
  });
});
