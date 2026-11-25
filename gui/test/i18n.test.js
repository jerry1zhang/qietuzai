const test = require('node:test');
const assert = require('node:assert/strict');
const { LOCALES, createTranslator, matchLocale, resolveLocale } = require('../shared/i18n.mjs');

const base = LOCALES.find((l) => l.code === 'zh-CN').dict;
const forms = (v) => (typeof v === 'object' ? Object.values(v) : [v]);
const placeholders = (s) => [...new Set(String(s).match(/\{\w+\}/g) || [])].sort();

test('多语言：10 种语言，代码不重复', () => {
  assert.equal(LOCALES.length, 10);
  assert.equal(new Set(LOCALES.map((l) => l.code)).size, 10);
});

for (const { code, dict } of LOCALES) {
  test(`多语言：${code} 的键和简体中文一致，占位符齐全`, () => {
    const missing = Object.keys(base).filter((k) => !(k in dict));
    const extra = Object.keys(dict).filter((k) => !(k in base));
    assert.deepEqual(missing, [], `${code} 缺少这些键`);
    assert.deepEqual(extra, [], `${code} 多出这些键`);
    for (const [key, value] of Object.entries(dict)) {
      // 每个复数形式里的占位符都要和简体中文一样，不能漏掉也不能多出
      const want = placeholders(forms(base[key]).join(' '));
      for (const f of forms(value)) {
        assert.equal(typeof f, 'string', `${code} ${key}`);
        assert.ok(f.trim(), `${code} ${key} 是空的`);
        assert.deepEqual(placeholders(f), want, `${code} ${key} 的占位符不对：${f}`);
      }
      if (typeof value === 'object') {
        assert.ok(value.other, `${code} ${key} 缺少 other`);
        // 这门语言整数会用到的每种复数形式都要有，免得退回 other 时语法不对
        const rules = new Intl.PluralRules(code);
        for (let n = 0; n <= 200; n += 1) assert.ok(rules.select(n) in value, `${code} ${key} 缺少 ${rules.select(n)}（n=${n}）`);
      }
    }
  });
}

test('多语言：系统语言对应到支持的语言', () => {
  assert.equal(matchLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(matchLocale('zh-CN'), 'zh-CN');
  assert.equal(matchLocale('zh'), 'zh-CN');
  assert.equal(matchLocale('zh-SG'), 'zh-CN');
  assert.equal(matchLocale('zh-TW'), 'zh-TW');
  assert.equal(matchLocale('zh-HK'), 'zh-TW');
  assert.equal(matchLocale('zh_Hant_MO'), 'zh-TW');
  assert.equal(matchLocale('zh-Hant'), 'zh-TW');
  assert.equal(matchLocale('zh-Hans-HK'), 'zh-CN');
  assert.equal(matchLocale('zh-Hans-TW'), 'zh-CN');
  assert.equal(matchLocale('zh-Hant-CN'), 'zh-TW');
  assert.equal(matchLocale('pt-PT'), 'pt-BR');
  assert.equal(matchLocale('en-GB'), 'en');
  assert.equal(matchLocale('ja-JP'), 'ja');
  assert.equal(matchLocale('de-AT'), 'de');
  assert.equal(matchLocale('it-IT'), null);
  assert.equal(matchLocale(''), null);

  // 按系统语言的优先级找第一个支持的；都不支持时用英文
  assert.equal(resolveLocale('system', ['it-IT', 'fr-CA', 'en-US']), 'fr');
  assert.equal(resolveLocale('system', ['it-IT']), 'en');
  assert.equal(resolveLocale('system', []), 'en');
  assert.equal(resolveLocale(undefined, ['ko-KR']), 'ko');
  // 手动选的语言优先；认不出的设置值按跟随系统处理
  assert.equal(resolveLocale('ru', ['zh-CN']), 'ru');
  assert.equal(resolveLocale('xx', ['zh-CN']), 'zh-CN');
});

test('多语言：占位符、复数和缺键时的退回', () => {
  const en = createTranslator('en');
  assert.equal(en('workspace.imageCount', { count: 1 }), '1 image');
  assert.equal(en('workspace.imageCount', { count: 3 }), '3 images');
  assert.equal(en('settings.apiUrlActual', { url: 'http://x/v1' }), 'Requests go to: http://x/v1');
  // 没传的占位符原样保留，方便发现问题
  assert.equal(en('settings.apiUrlActual'), 'Requests go to: {url}');
  assert.equal(en('no.such.key'), 'no.such.key');

  const ru = createTranslator('ru');
  assert.equal(ru('workspace.imageCount', { count: 1 }), '1 изображение');
  assert.equal(ru('workspace.imageCount', { count: 3 }), '3 изображения');
  assert.equal(ru('workspace.imageCount', { count: 5 }), '5 изображений');
  assert.equal(ru('workspace.imageCount', { count: 21 }), '21 изображение');

  const zh = createTranslator('zh-CN');
  assert.equal(zh('workspace.imageCount', { count: 3 }), '3 张图');
  assert.equal(createTranslator('xx').locale, 'en');
});

test('多语言：主进程的报错和写进提示词的尺寸描述跟着当前语言', () => {
  const i18n = require('../shared/i18n.mjs');
  const gen = require('../electron/generator');
  const { normalizeSettings } = require('../electron/store');
  try {
    i18n.setLocale('en');
    assert.equal(gen.sizeHintText('1536x1024'), 'Output image size: 1536x1024 (landscape, 3:2).');
    assert.equal(gen.sizeHintText('1672x941'), 'Output image size: 1672x941 (landscape).');
    assert.equal(gen.sizeHintText('9:16'), 'Output image aspect ratio: 9:16 (portrait).');
    assert.throws(() => gen.resolveRunSize({ sizes: [] }, 'abc'), /^Error: Invalid size: abc\. Write the size/);
    i18n.setLocale('ja');
    assert.equal(gen.sizeHintText('1024x1024'), '出力画像のサイズは 1024x1024（正方形、1:1）。');
    i18n.setLocale('zh-CN');
    assert.equal(gen.sizeHintText('1536x1024'), '输出图片尺寸为 1536x1024（横版，3:2）。');
  } finally {
    i18n.setLocale('zh-CN');
  }
  // 设置里的语言：认得的代码保留，其他的当作跟随系统
  assert.equal(normalizeSettings({ language: 'ja' }).language, 'ja');
  assert.equal(normalizeSettings({ language: 'xx' }).language, 'system');
  assert.equal(normalizeSettings({}).language, 'system');
  // 手改 settings.json 写成数组、对象时也按跟随系统处理，不会读设置时报错
  assert.equal(normalizeSettings({ language: ['fr'] }).language, 'system');
  assert.equal(normalizeSettings({ language: { toString: null } }).language, 'system');
  assert.equal(resolveLocale(['fr'], ['ja-JP']), 'ja');
});
