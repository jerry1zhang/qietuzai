// 保存设置后，输入框草稿怎么跟着变
const test = require('node:test');
const assert = require('node:assert/strict');
const { draftAfterSettingsSaved, draftFromSettings } = require('../src/draft.mjs');
const { normalizeSettings } = require('../electron/store');

const base = normalizeSettings({
  models: ['gpt-image-1', 'dall-e-3'],
  defaultModel: 'gpt-image-1',
  sizes: ['1024x1024', '1536x1024', '2K'],
  defaultSize: '1024x1024',
  defaultQuality: 'high',
  defaultCount: 2,
});

test('草稿：只切换语言时，手动输入的模型和改过的参数都保留', () => {
  const draft = { ...draftFromSettings(base), prompt: '猫', model: 'my-custom-model', size: '2K', count: 4 };
  const { draft: d, droppedSize } = draftAfterSettingsSaved(draft, base, { ...base, language: 'ja' });
  assert.equal(d.model, 'my-custom-model');
  assert.equal(d.size, '2K');
  assert.equal(d.count, 4);
  assert.equal(d.prompt, '猫');
  assert.equal(droppedSize, null);
});

test('草稿：正在用的模型从列表里删掉了才换回默认模型', () => {
  const draft = { ...draftFromSettings(base), model: 'dall-e-3' };
  const next = { ...base, models: ['gpt-image-1'] };
  assert.equal(draftAfterSettingsSaved(draft, base, next).draft.model, 'gpt-image-1');
  // 手动输入的模型本来就不在列表里，删别的模型也不影响它
  const custom = { ...draft, model: 'my-custom-model' };
  assert.equal(draftAfterSettingsSaved(custom, base, next).draft.model, 'my-custom-model');
});

test('草稿：没改过的参数跟着新默认值走，改过的不动', () => {
  const draft = { ...draftFromSettings(base), quality: 'low' };
  const next = { ...base, defaultModel: 'dall-e-3', defaultSize: '1536x1024', defaultQuality: 'medium', defaultCount: 3 };
  const { draft: d } = draftAfterSettingsSaved(draft, base, next);
  assert.deepEqual([d.model, d.size, d.quality, d.count], ['dall-e-3', '1536x1024', 'low', 3]);
});

test('草稿：正在用的非标准尺寸从可选列表删掉后换回默认尺寸，并告知被换掉的是哪个', () => {
  const draft = { ...draftFromSettings(base), size: '2K' };
  const next = { ...base, sizes: ['1024x1024', '1536x1024'] };
  const { draft: d, droppedSize } = draftAfterSettingsSaved(draft, base, next);
  assert.equal(d.size, '1024x1024');
  assert.equal(droppedSize, '2K');
  // 「编辑后重试」从历史记录带来的旧写法照常保留
  const fromHistory = { ...draft, historySize: '2K' };
  assert.equal(draftAfterSettingsSaved(fromHistory, base, next).droppedSize, null);
});
