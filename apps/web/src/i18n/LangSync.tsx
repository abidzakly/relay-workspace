import { useEffect } from 'react';
import { useUiStore } from '@/store/ui';
import { i18n } from './index';

/** Keeps i18next and `<html lang>` in step with the stored language (also when another tab changes it). */
export function LangSync() {
  const lang = useUiStore((s) => s.lang);
  useEffect(() => {
    if (i18n.language !== lang) void i18n.changeLanguage(lang);
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}
