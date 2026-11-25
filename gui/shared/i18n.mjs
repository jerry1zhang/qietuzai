// 界面语言。主进程用 require() 加载，界面用 import 加载，两边共用这一份。
//
// 词典在 locales/ 下，每种语言一个文件，键以 zh-CN.mjs 为准（test/i18n.test.js 会检查各语言的键和占位符是否齐全）。
// 值可以是字符串，也可以是按数量变化的对象 { one, few, many, other }（俄语等需要），用 {count} 选择。
// 占位符写成 {name}，调用时 t('key', { name: '...' })。
import zhCN from './locales/zh-CN.mjs';
import zhTW from './locales/zh-TW.mjs';
import en from './locales/en.mjs';
import ja from './locales/ja.mjs';
import ko from './locales/ko.mjs';
import es from './locales/es.mjs';
import fr from './locales/fr.mjs';
import de from './locales/de.mjs';
import ptBR from './locales/pt-BR.mjs';
import ru from './locales/ru.mjs';

// name 用各语言自己的写法，方便不认识当前界面语言的人也能找到自己的语言
export const LOCALES = [
  { code: 'zh-CN', name: '简体中文', dict: zhCN },
  { code: 'zh-TW', name: '繁體中文', dict: zhTW },
  { code: 'en', name: 'English', dict: en },
  { code: 'ja', name: '日本語', dict: ja },
  { code: 'ko', name: '한국어', dict: ko },
  { code: 'es', name: 'Español', dict: es },
  { code: 'fr', name: 'Français', dict: fr },
  { code: 'de', name: 'Deutsch', dict: de },
  { code: 'pt-BR', name: 'Português (Brasil)', dict: ptBR },
  { code: 'ru', name: 'Русский', dict: ru },
];

// 系统语言都不支持时用英文
export const FALLBACK_LOCALE = 'en';

const DICTS = Object.fromEntries(LOCALES.map((l) => [l.code, l.dict]));

// 只认字符串：settings.json 可能被手改成数组、对象等，不能隐式转换成属性名
export const isLocale = (code) => typeof code === 'string' && Object.hasOwn(DICTS, code);

// 系统语言标签（zh-Hans-CN、zh_TW、pt-PT、en-US…）对应到支持的语言，不支持时返回 null
export function matchLocale(tag) {
  const t = String(tag || '').replace(/_/g, '-').toLowerCase();
  const lang = t.split('-')[0];
  if (!lang) return null;
  if (lang === 'zh') {
    // 标签里写明了字形（zh-Hans-HK 是香港的简体）就按字形；没写时，台湾、香港、澳门用繁体
    if (/-hans\b/.test(t)) return 'zh-CN';
    if (/-hant\b/.test(t)) return 'zh-TW';
    return /-(tw|hk|mo)\b/.test(t) ? 'zh-TW' : 'zh-CN';
  }
  if (lang === 'pt') return 'pt-BR';
  return LOCALES.find((l) => l.code.toLowerCase() === lang)?.code ?? null;
}

// 设置里的语言（'system' 或语言代码）+ 系统语言列表（按优先级）→ 实际使用的语言
export function resolveLocale(pref, systemLanguages = []) {
  if (pref && pref !== 'system' && isLocale(pref)) return pref;
  for (const tag of systemLanguages || []) {
    const hit = matchLocale(tag);
    if (hit) return hit;
  }
  return FALLBACK_LOCALE;
}

// 返回 t(key, vars)。当前语言缺的键依次退回英文、简体中文，都没有时显示键名
export function createTranslator(locale) {
  const code = isLocale(locale) ? locale : FALLBACK_LOCALE;
  const dict = DICTS[code];
  const plural = new Intl.PluralRules(code);
  const t = (key, vars = {}) => {
    let v = dict[key] ?? DICTS[FALLBACK_LOCALE][key] ?? DICTS['zh-CN'][key] ?? key;
    if (v && typeof v === 'object') v = v[plural.select(Number(vars.count) || 0)] ?? v.other;
    return String(v).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  };
  t.locale = code;
  return t;
}

// 主进程用的全局语言：启动时和保存设置后由 main.js 设置
let current = createTranslator(FALLBACK_LOCALE);

export function setLocale(locale) {
  current = createTranslator(locale);
  return current.locale;
}

export const getLocale = () => current.locale;

export const t = (key, vars) => current(key, vars);
