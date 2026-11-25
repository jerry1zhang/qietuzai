// 输入框草稿和设置之间的规则。不依赖界面和 window.api，单元测试直接加载（test/draft.test.js）
import { isUsableSize } from '../shared/size.mjs';

export function draftFromSettings(s) {
  return {
    prompt: '',
    attachments: [],
    maskPath: null,
    model: s.defaultModel,
    size: s.defaultSize,
    quality: s.defaultQuality,
    count: s.defaultCount,
    outName: '',
    perLine: false,
  };
}

const PARAM_KEYS = [
  ['model', 'defaultModel'],
  ['size', 'defaultSize'],
  ['quality', 'defaultQuality'],
  ['count', 'defaultCount'],
];

// 把生成参数换成设置里的默认值，保留已输入的提示词和参考图
export function withDefaults(d, s) {
  const next = { ...d };
  for (const [k, sk] of PARAM_KEYS) next[k] = s[sk];
  return next;
}

// 草稿的尺寸是不是「编辑后重试」从历史记录带过来、而且没改过的：是的话，旧版本存下的写法也原样发送
export const sizeFromHistory = (d) => d.historySize != null && d.size === d.historySize;

/**
 * 保存设置后调整草稿，返回 { draft, droppedSize }：
 * - 还是旧默认值（没被手动改过）的参数，跟着换成新默认值
 * - 正在用的模型这次被从模型列表里删掉了，换成默认模型。手动输入、本来就不在列表里的模型保留
 *   （只切换语言等无关的保存不会动它）
 * - 正在用的尺寸已经不能用了（从可选列表删掉、又不是标准写法），换成默认尺寸，droppedSize 是被换掉的尺寸
 *   （用来提示用户），免得预览和提交报错；没换时为 null
 */
export function draftAfterSettingsSaved(d, prev, next) {
  const draft = { ...d };
  for (const [k, sk] of PARAM_KEYS) if (d[k] === prev[sk]) draft[k] = next[sk];
  if ((prev.models || []).includes(draft.model) && !(next.models || []).includes(draft.model)) draft.model = next.defaultModel;
  let droppedSize = null;
  if (!isUsableSize(draft.size, next, { fromHistory: sizeFromHistory(draft) })) {
    droppedSize = draft.size;
    draft.size = next.defaultSize;
  }
  return { draft, droppedSize };
}
