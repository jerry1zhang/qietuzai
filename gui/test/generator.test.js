const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gen = require('../electron/generator');
const { PNG, PNG_B64, tmpDir, jsonResponse, fakeApi, makeSettings, makeRun, collector } = require('./helpers');

test('接口地址归一化（与 img.sh 一致）', () => {
  const cases = [
    ['https://api.example.com', 'https://api.example.com/v1'],
    ['https://api.example.com/', 'https://api.example.com/v1'],
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/images/generations', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/images/edits/', 'https://api.example.com/v1'],
    ['  ', ''],
  ];
  for (const [input, want] of cases) assert.equal(gen.resolveApiBase(input), want, input);
});

test('Agents 提示词加在最前面，中间空一行', () => {
  assert.deepEqual(gen.applyAgents({ agentsEnabled: true, agentsPrompt: ' 扁平风格 ' }, '一只猫'), {
    finalPrompt: '扁平风格\n\n一只猫',
    agentsApplied: true,
  });
  assert.equal(gen.applyAgents({ agentsEnabled: false, agentsPrompt: '扁平风格' }, '一只猫').finalPrompt, '一只猫');
  assert.equal(gen.applyAgents({ agentsEnabled: true, agentsPrompt: '   ' }, '一只猫').agentsApplied, false);
});

test('base64 严格解码', () => {
  assert.deepEqual(gen.decodeBase64(PNG_B64), PNG);
  assert.deepEqual(gen.decodeBase64(`data:image/png;base64,${PNG_B64}`), PNG);
  assert.deepEqual(gen.decodeBase64(PNG_B64.replace(/(.{10})/g, '$1\n')), PNG);
  assert.deepEqual(gen.decodeBase64(PNG.toString('base64url')), PNG);
  assert.throws(() => gen.decodeBase64('not base64!'), /base64 数据无效/);
  assert.throws(() => gen.decodeBase64(''), /base64 数据无效/);
});

test('响应解析：兼容的各种格式都能保存成图片', async () => {
  const shapes = {
    'data[].b64_json': { data: [{ b64_json: PNG_B64 }] },
    'images[].b64': { images: [{ b64: PNG_B64 }] },
    'results[].image_base64': { results: [{ image_base64: PNG_B64 }] },
    'data[].base64': { data: [{ base64: PNG_B64 }] },
    'data[] 直接是字符串': { data: [PNG_B64] },
    'data[].url': { data: [{ url: 'http://cdn.test/a.png' }] },
    'data[].image_url.url': { data: [{ image_url: { url: 'http://cdn.test/b.png' } }] },
  };
  for (const [name, body] of Object.entries(shapes)) {
    const dir = tmpDir();
    const { fetchImpl } = fakeApi((url) => (url.startsWith('http://cdn.test/') ? new Response(PNG) : jsonResponse(body)));
    const { items, onItem } = collector(1);
    await gen.runGeneration({ settings: makeSettings(dir), run: makeRun(), signal: new AbortController().signal, onItem, fetchImpl });
    assert.equal(items[0].status, 'done', `${name}: ${items[0].error}`);
    assert.deepEqual(fs.readFileSync(items[0].path), PNG, name);
  }
});

test('响应解析：无效内容标记为失败，不保存文件', async () => {
  const cases = [
    ['非法 base64', () => jsonResponse({ data: [{ b64_json: 'not base64!' }] }), /base64 数据无效/],
    ['合法 base64 但不是图片', () => jsonResponse({ data: [{ b64_json: Buffer.from('hello world').toString('base64') }] }), /不是 PNG/],
    ['下载到的是网页', (url) => (url.startsWith('http://cdn.test/') ? new Response('<html>oops</html>') : jsonResponse({ data: [{ url: 'http://cdn.test/x' }] })), /不是 PNG/],
    ['下载 404', (url) => (url.startsWith('http://cdn.test/') ? new Response('nope', { status: 404 }) : jsonResponse({ data: [{ url: 'http://cdn.test/x' }] })), /下载失败: HTTP 404/],
    ['既无 b64 也无 url', () => jsonResponse({ data: [{}] }), /既无 b64_json 也无 url/],
    ['非 JSON', () => new Response('<html>bad gateway</html>'), /无法解析响应/],
    [
      '接口报错',
      () => jsonResponse({ error: { message: 'rejected by safety system', type: 'invalid_request_error', code: 'moderation_blocked' } }, 400),
      /^HTTP 400: rejected by safety system \(invalid_request_error \/ moderation_blocked\)$/,
    ],
  ];
  for (const [name, respond, want] of cases) {
    const dir = tmpDir();
    const { fetchImpl } = fakeApi(respond);
    const { items, onItem } = collector(1);
    await gen.runGeneration({ settings: makeSettings(dir), run: makeRun(), signal: new AbortController().signal, onItem, fetchImpl });
    assert.equal(items[0].status, 'error', name);
    assert.match(items[0].error, want, name);
    assert.deepEqual(fs.readdirSync(dir), [], `${name}: 不应留下文件`);
  }
});

test('文生图请求体：JSON，n=1，quality 为空时不发送', async () => {
  const { fetchImpl, stats } = fakeApi(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  const { onItem } = collector(1);
  await gen.runGeneration({ settings: makeSettings(tmpDir()), run: makeRun(), signal: new AbortController().signal, onItem, fetchImpl });
  const { url, init } = stats.calls[0];
  assert.equal(url, 'http://api.test/v1/images/generations');
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(init.body), { model: 'gpt-image-1', prompt: '一只猫', n: 1, size: '1024x1024' });
});

test('图生图请求体：multipart，单图 image、多图 image[]、蒙版，换行原样保留', async () => {
  const dir = tmpDir();
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  const m = path.join(dir, 'mask.png');
  for (const f of [a, b, m]) fs.writeFileSync(f, PNG);
  const prompt = '第一行\n第二行 "引号"';

  const parse = async (init) => new Response(init.body, { headers: { 'content-type': init.headers['Content-Type'] } }).formData();
  const runOnce = async (inputs, mask) => {
    const { fetchImpl, stats } = fakeApi(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
    const { items, onItem } = collector(1);
    const run = makeRun({ finalPrompt: prompt, inputs: inputs.map((p) => ({ path: p, name: path.basename(p) })), mask: mask && { path: mask, name: 'mask.png' } });
    await gen.runGeneration({ settings: makeSettings(path.join(dir, 'out')), run, signal: new AbortController().signal, onItem, fetchImpl });
    assert.equal(items[0].status, 'done', items[0].error);
    assert.equal(stats.calls[0].url, 'http://api.test/v1/images/edits');
    return parse(stats.calls[0].init);
  };

  const single = await runOnce([a]);
  assert.equal(single.getAll('image').length, 1);
  assert.equal(single.get('prompt'), prompt);
  assert.equal(single.get('n'), '1');

  const multi = await runOnce([a, b], m);
  assert.equal(multi.getAll('image[]').length, 2);
  assert.equal(multi.get('image'), null);
  assert.equal(multi.get('mask').name, 'mask.png');
  assert.equal(multi.get('prompt'), prompt);
});

test('并发上限由所有任务共用，同名输出互不覆盖', async () => {
  const dir = tmpDir();
  const limiter = new gen.Limiter(() => 2);
  const { fetchImpl, stats } = fakeApi(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }), { delay: 30 });
  const runs = ['A', 'B', 'C'].map((p) => ({ run: makeRun({ finalPrompt: p, count: 3, outName: 'same.png' }), ...collector(3) }));
  await Promise.all(
    runs.map(({ run, onItem }) => gen.runGeneration({ settings: makeSettings(dir), run, signal: new AbortController().signal, onItem, limiter, fetchImpl })),
  );
  assert.equal(stats.calls.length, 9);
  assert.equal(stats.max, 2, '同时进行的请求不应超过并发上限');
  const paths = runs.flatMap((r) => r.items.map((i) => i.path));
  assert.ok(runs.every((r) => r.items.every((i) => i.status === 'done')));
  assert.equal(new Set(paths).size, 9, '9 张图应写到 9 个不同的文件');
  assert.equal(fs.readdirSync(dir).length, 9);
  assert.ok(fs.existsSync(path.join(dir, 'same-1.png')) && fs.existsSync(path.join(dir, 'same-1 (3).png')));
  assert.equal(limiter.active, 0);
});

test('不覆盖已有文件', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'keep.png'), 'old');
  const { fetchImpl } = fakeApi(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  const { items, onItem } = collector(1);
  await gen.runGeneration({ settings: makeSettings(dir), run: makeRun({ outName: 'keep.png' }), signal: new AbortController().signal, onItem, fetchImpl });
  assert.equal(path.basename(items[0].path), 'keep (2).png');
  assert.equal(fs.readFileSync(path.join(dir, 'keep.png'), 'utf8'), 'old');
});

test('取消：进行中和排队中的都标记为已取消，并发名额被释放', async () => {
  const dir = tmpDir();
  const limiter = new gen.Limiter(() => 1);
  const { fetchImpl } = fakeApi(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }), { delay: 200 });
  const ctrl = new AbortController();
  const first = collector(3);
  const p = gen.runGeneration({ settings: makeSettings(dir), run: makeRun({ count: 3 }), signal: ctrl.signal, onItem: first.onItem, limiter, fetchImpl });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(first.items.map((i) => i.status), ['running', 'pending', 'pending']);
  ctrl.abort();
  await p;
  assert.deepEqual(first.items.map((i) => i.status), ['canceled', 'canceled', 'canceled']);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.queue.length, 0);

  // 取消之后，新任务能正常拿到名额
  const next = collector(1);
  await gen.runGeneration({ settings: makeSettings(dir), run: makeRun(), signal: new AbortController().signal, onItem: next.onItem, limiter, fetchImpl });
  assert.equal(next.items[0].status, 'done');
});

test('输出扩展名以图片实际格式为准', async () => {
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 1)]);
  const cases = [
    ['banner.avif', PNG, 'banner.png'],
    ['photo.jpeg', PNG, 'photo.png'],
    ['photo.jpeg', JPEG, 'photo.jpeg'],
    ['photo.JPG', JPEG, 'photo.jpg'],
    ['photo.png', JPEG, 'photo.jpg'],
    ['banner.v2', PNG, 'banner.v2.png'],
    ['banner', JPEG, 'banner.jpg'],
  ];
  for (const [outName, bytes, want] of cases) {
    const dir = tmpDir();
    const { fetchImpl } = fakeApi(() => jsonResponse({ data: [{ b64_json: bytes.toString('base64') }] }));
    const { items, onItem } = collector(1);
    await gen.runGeneration({ settings: makeSettings(dir), run: makeRun({ outName }), signal: new AbortController().signal, onItem, fetchImpl });
    assert.equal(items[0].status, 'done', `${outName}: ${items[0].error}`);
    assert.equal(path.basename(items[0].path), want, outName);
  }
});
