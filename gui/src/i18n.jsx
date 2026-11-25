// 界面的翻译函数通过 React context 传下去：切换语言时用到 t 的组件都会重新渲染
import React, { createContext, useContext } from 'react';
import { createTranslator, FALLBACK_LOCALE } from '../shared/i18n.mjs';

export { LOCALES, resolveLocale, createTranslator } from '../shared/i18n.mjs';

const I18nContext = createContext(createTranslator(FALLBACK_LOCALE));

export function I18nProvider({ t, children }) {
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

// 返回 t(key, vars)，t.locale 是当前语言代码
export function useT() {
  return useContext(I18nContext);
}
