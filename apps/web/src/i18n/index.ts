import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { useUiStore, type Lang } from '@/store/ui';
import { en } from './locales/en';
import { id } from './locales/id';

export const LANGS: readonly { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'id', label: 'Bahasa Indonesia' },
];

/**
 * UI text in English and Indonesian (react-i18next). The language is a browser preference in the UI store; it is
 * read here once, before the first render, so the page never flashes English. `LangSync` follows later changes.
 */
void i18n.use(initReactI18next).init({
  resources: { en: { common: en }, id: { common: id } },
  lng: useUiStore.getState().lang,
  fallbackLng: 'en',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  // Some headline parts are empty on purpose (Indonesian needs no trailing word).
  returnEmptyString: true,
});

export { i18n };
