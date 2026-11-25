const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HistoryStore, normalizeSettings } = require('../electron/store');
const { tmpDir } = require('./helpers');

test('历史记录：上次退出时还在跑的任务标记为已中断', () => {
  const dir = tmpDir();
  const history = {
    version: 1,
    sessions: [
      {
        id: 's1',
        title: '测试',
        createdAt: 1,
        updatedAt: 1,
        runs: [
          { id: 'r1', status: 'running', items: [{ index: 0, status: 'done', path: '/x.png' }, { index: 1, status: 'running' }, { index: 2, status: 'pending' }] },
          { id: 'r2', status: 'done', finishedAt: 5, items: [{ index: 0, status: 'done' }] },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));

  const store = new HistoryStore(dir);
  const [r1, r2] = store.get('s1').runs;
  assert.equal(r1.status, 'interrupted');
  assert.ok(r1.finishedAt > 0);
  assert.deepEqual(r1.items.map((i) => i.status), ['done', 'error', 'error']);
  assert.equal(r1.items[1].error, '应用已关闭，任务中断');
  assert.equal(r2.status, 'done');
  assert.equal(r2.finishedAt, 5);

  // 修正结果已经写回文件
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
  assert.equal(saved.sessions[0].runs[0].status, 'interrupted');
});

test('历史记录：新建、改名、添加和删除记录后能持久化', () => {
  const dir = tmpDir();
  const store = new HistoryStore(dir);
  const s = store.create('第一个任务');
  store.addRun(s.id, { id: 'r1', status: 'done', items: [] });
  store.addRun(s.id, { id: 'r2', status: 'done', items: [] });
  store.rename(s.id, '改过的名字');
  store.removeRun(s.id, 'r1');
  store.flush();

  const reloaded = new HistoryStore(dir);
  const got = reloaded.get(s.id);
  assert.equal(got.title, '改过的名字');
  assert.deepEqual(got.runs.map((r) => r.id), ['r2']);
  assert.equal(reloaded.findRun('r2').session.id, s.id);

  reloaded.remove(s.id);
  reloaded.flush();
  assert.deepEqual(new HistoryStore(dir).list(), []);
});

test('历史记录：文件损坏时从空列表开始', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'history.json'), '{ broken');
  assert.deepEqual(new HistoryStore(dir).list(), []);
});

test('设置：能识别的尺寸统一写法，认不出的旧值原样保留', () => {
  const s = normalizeSettings({ sizes: ['1536×1024', '16：9', '1:1 方图', '1536x1024', ' '], defaultSize: '旧默认' });
  assert.deepEqual(s.sizes, ['1536x1024', '16:9', '1:1 方图']);
  assert.equal(s.defaultSize, '旧默认');
  assert.equal(normalizeSettings({ defaultSize: '800✖800' }).defaultSize, '800x800');
  assert.equal(normalizeSettings({}).sizeInPrompt, false);
});

test('设置：列表字段是字符串或其他类型时也能加载', () => {
  const s = normalizeSettings({ sizes: '1024x1024, 16：9', models: 'gpt-image-1,gpt-image-2', qualities: 'high' });
  assert.deepEqual(s.sizes, ['1024x1024', '16:9']);
  assert.deepEqual(s.models, ['gpt-image-1', 'gpt-image-2']);
  assert.deepEqual(s.qualities, ['high']);
  const t = normalizeSettings({ sizes: 1024, models: null, qualities: { a: 1 } });
  assert.deepEqual(t.sizes, ['1024x1024', '1536x1024', '1024x1536', 'auto']);
  assert.deepEqual(t.models, ['gpt-image-1']);
  assert.deepEqual(t.qualities, []);
});

test('设置：两次保存交错时按顺序写入，不会用旧内容覆盖新设置', async () => {
  const { SettingsStore } = require('../electron/store');
  const dir = tmpDir();
  const store = await SettingsStore.load(dir);
  // 假的异步加密：第一次很慢、第二次很快。不排队的话，第一次会最后写文件，把第二次的修改冲掉
  const delays = [80, 5];
  store.safe = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: (s) => new Promise((r) => setTimeout(() => r(Buffer.from(`enc:${s}`)), delays.shift() ?? 0)),
  };
  await Promise.all([
    store.save({ language: 'ja', apiKey: 'sk-one' }),
    store.save({ apiUrl: 'https://example.com/v1', apiKey: 'sk-two' }),
  ]);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(onDisk.language, 'ja');
  assert.equal(onDisk.apiUrl, 'https://example.com/v1');
  assert.equal(Buffer.from(onDisk.apiKeyEnc, 'base64').toString(), 'enc:sk-two');
  assert.equal(onDisk.apiKey, undefined, '加密成功时不写明文');

  // 前一次保存失败也不影响后面排队的保存
  store.safe = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async () => Buffer.from('x') };
  const bad = store.save({ timeoutSec: 30, models: null, get defaultModel() { throw new Error('boom'); } });
  await assert.rejects(bad, /boom/);
  await store.save({ timeoutSec: 45 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).timeoutSec, 45);
});

test('设置：Key 没变时沿用原来的密文，钥匙串暂时不可用也不会降级成明文', async () => {
  const { SettingsStore } = require('../electron/store');
  const dir = tmpDir();
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const store = await SettingsStore.load(dir);
  let calls = 0;
  store.safe = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => {
      calls += 1;
      return Buffer.from(`enc:${s}`);
    },
  };
  await store.save({ apiKey: 'sk-secret' });
  const first = read().apiKeyEnc;
  assert.ok(first);

  // 钥匙串暂时不可用时只切换语言：密文原样保留，不写明文，也不重新加密
  store.safe = { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async () => assert.fail('不应重新加密') };
  await store.save({ language: 'ja' });
  assert.equal(read().apiKeyEnc, first);
  assert.equal(read().apiKey, undefined);
  assert.equal(read().language, 'ja');
  assert.equal(store.keyStorage, 'keychain');
  assert.equal(calls, 1);

  // 换了 Key 又没法加密时，才按原来的规则退回明文，设置页会显示「明文」
  await store.save({ apiKey: 'sk-new' });
  assert.equal(read().apiKey, 'sk-new');
  assert.equal(read().apiKeyEnc, undefined);
  assert.equal(store.keyStorage, 'plain');
});

test('设置：启动时解不开的 Key 密文，在填新 Key 之前一直保留', async () => {
  const { SettingsStore } = require('../electron/store');
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  // 单元测试里没有 Electron 的钥匙串，解密必然失败，相当于钥匙串暂时不可用
  fs.writeFileSync(file, JSON.stringify({ apiUrl: 'https://example.com/v1', apiKeyEnc: 'b2xkLWNpcGhlcnRleHQ=' }));
  const store = await SettingsStore.load(dir);
  assert.equal(store.get().apiKey, '');

  await store.save({ language: 'ja' });
  let onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.apiKeyEnc, 'b2xkLWNpcGhlcnRleHQ=', '只切换语言不应删掉原来的密文');
  assert.equal(onDisk.language, 'ja');
  await store.save({ apiKey: '' }); // 表单里 Key 本来就是空的，原样保存也不删
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKeyEnc, 'b2xkLWNpcGhlcnRleHQ=');

  // 填了新 Key 之后旧密文才作废
  store.safe = { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async () => assert.fail() };
  await store.save({ apiKey: 'sk-new' });
  onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.apiKey, 'sk-new');
  assert.equal(onDisk.apiKeyEnc, undefined);
  await store.save({ apiKey: '' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKeyEnc, undefined, '清空新 Key 时旧密文不会回来');
});

test('设置：解不开的旧密文只在接口地址没变时保留，换了地址重启后不会带上旧 Key', async () => {
  const { SettingsStore } = require('../electron/store');
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ apiUrl: 'https://old.example.com/v1', apiKeyEnc: 'b2xkLWNpcGhlcnRleHQ=' }));
  const store = await SettingsStore.load(dir);
  await store.save({ apiUrl: 'https://new.example.com/v1' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKeyEnc, undefined);
  // 改回原来的地址也不会再出现
  await store.save({ apiUrl: 'https://old.example.com/v1' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKeyEnc, undefined);
  // 重启后读到的是没有 Key 的设置
  const again = await SettingsStore.load(dir);
  assert.equal(again.get().apiKey, '');
  assert.equal(again.keyEncUnreadable, null);
});

test('设置：写盘失败时内存里还是旧设置，之后只切换语言不会把失败的改动写进去', async () => {
  const { SettingsStore } = require('../electron/store');
  const dir = tmpDir();
  const store = await SettingsStore.load(dir);
  await store.save({ apiUrl: 'https://good.example.com/v1' });
  const realFile = store.file;
  // 让写盘失败：目标目录的上一级是个普通文件
  fs.writeFileSync(path.join(dir, 'blocker'), '');
  store.file = path.join(dir, 'blocker', 'settings.json');
  await assert.rejects(store.save({ apiUrl: 'https://bad.example.com/v1', proxy: 'http://127.0.0.1:1' }));
  assert.equal(store.get().apiUrl, 'https://good.example.com/v1');
  assert.equal(store.get().proxy, '');

  store.file = realFile;
  await store.save({ language: 'ja' });
  const onDisk = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  assert.equal(onDisk.apiUrl, 'https://good.example.com/v1');
  assert.equal(onDisk.proxy, '');
  assert.equal(onDisk.language, 'ja');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], '不留下临时文件');
});

test('设置：解不开的旧 Key 显示为 locked，可以直接删除，重启后不会恢复', async () => {
  const { SettingsStore } = require('../electron/store');
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ apiUrl: 'https://example.com/v1', apiKeyEnc: 'b2xkLWNpcGhlcnRleHQ=' }));
  const store = await SettingsStore.load(dir);
  assert.equal(store.keyStorage, 'locked');
  await store.save({ language: 'ja' });
  assert.equal(store.keyStorage, 'locked');

  await store.forgetUnreadableKey();
  assert.equal(store.keyStorage, 'none');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.apiKeyEnc, undefined);
  assert.equal(onDisk.language, 'ja');
  assert.equal(onDisk.apiUrl, 'https://example.com/v1');

  const again = await SettingsStore.load(dir);
  assert.equal(again.keyStorage, 'none');
  assert.equal(again.keyEncUnreadable, null);
});
