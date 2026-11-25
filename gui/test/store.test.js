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
