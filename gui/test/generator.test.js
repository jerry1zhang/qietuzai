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

// ---------- 尺寸相关 ----------
const pngOf = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const riff = (kind, payload) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(kind), Buffer.alloc(4), payload]);

test('尺寸写法统一成「宽x高」，格式不对返回 null', () => {
  const cases = [
    ['1536x1024', '1536x1024'],
    ['1536X1024', '1536x1024'],
    ['1536×1024', '1536x1024'],
    ['800✖800', '800x800'],
    [' 1024 * 1536 ', '1024x1536'],
    ['１０２４ｘ１０２４', '1024x1024'],
    ['AUTO', 'auto'],
    ['', ''],
    ['abc', null],
    ['0x100', null],
    ['1024x', null],
    ['16:9', '16:9'],
    ['16：9', '16:9'],
    ['0:9', null],
  ];
  for (const [input, want] of cases) assert.equal(gen.normalizeSize(input), want, input);
});

test('尺寸写进提示词：方向和比例', () => {
  assert.equal(gen.sizeHintText('1536x1024'), '输出图片尺寸为 1536x1024（横版，3:2）。');
  assert.equal(gen.sizeHintText('1024x1536'), '输出图片尺寸为 1024x1536（竖版，2:3）。');
  assert.equal(gen.sizeHintText('1024x1024'), '输出图片尺寸为 1024x1024（正方形，1:1）。');
  assert.equal(gen.sizeHintText('1672x941'), '输出图片尺寸为 1672x941（横版）。');
  assert.equal(gen.sizeHintText('auto'), '');
  assert.equal(gen.sizeHintText('16:9'), '输出图片比例为 16:9（横版）。');
  assert.equal(gen.sizeHintText('1:1'), '输出图片比例为 1:1（正方形）。');
  // 旧版本存下的写法：认得的照样解读，校验不过的不生成描述
  assert.equal(gen.sizeHintText('1024X1536'), '输出图片尺寸为 1024x1536（竖版，2:3）。');
  assert.equal(gen.sizeHintText('0x100'), '');
  assert.equal(gen.sizeHintText('0:9'), '');
  assert.equal(gen.buildFinalPrompt({ sizeInPrompt: true }, '猫', 'abc').finalPrompt, '猫');

  const on = { agentsEnabled: true, agentsPrompt: '扁平风格', sizeInPrompt: true };
  assert.deepEqual(gen.buildFinalPrompt(on, '一只猫', '2048x1152'), {
    finalPrompt: '扁平风格\n\n一只猫\n\n输出图片尺寸为 2048x1152（横版，16:9）。',
    agentsApplied: true,
    sizeHint: '输出图片尺寸为 2048x1152（横版，16:9）。',
  });
  assert.equal(gen.buildFinalPrompt({ ...on, sizeInPrompt: false }, '一只猫', '2048x1152').finalPrompt, '扁平风格\n\n一只猫');
  assert.equal(gen.buildFinalPrompt(on, '一只猫', 'auto').sizeHint, '');
});

test('从文件头读出图片宽高', () => {
  const jpeg = (w, h) =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3]),
      Buffer.alloc(16),
    ]);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0x7b, 0x00]), Buffer.alloc(8)]);
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE(1671, 4, 3);
  vp8x.writeUIntLE(940, 7, 3);
  const vp8 = Buffer.alloc(10);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(vp8, 3);
  vp8.writeUInt16LE(1536, 6);
  vp8.writeUInt16LE(1024, 8);
  const vp8l = Buffer.alloc(10);
  vp8l[0] = 0x2f;
  vp8l.writeUInt32LE((321 - 1) | ((123 - 1) << 14), 1);

  assert.deepEqual(gen.imageSize(pngOf(1672, 941)), { width: 1672, height: 941 });
  assert.deepEqual(gen.imageSize(jpeg(1536, 1024)), { width: 1536, height: 1024 });
  assert.deepEqual(gen.imageSize(gif), { width: 320, height: 123 });
  assert.deepEqual(gen.imageSize(riff('VP8X', vp8x)), { width: 1672, height: 941 });
  assert.deepEqual(gen.imageSize(riff('VP8 ', vp8)), { width: 1536, height: 1024 });
  assert.deepEqual(gen.imageSize(riff('VP8L', vp8l)), { width: 321, height: 123 });
  assert.equal(gen.imageSize(Buffer.from('hello')), null);
});

test('生成结果里记下实际宽高', async () => {
  const { fetchImpl } = fakeApi(() => jsonResponse({ data: [{ b64_json: pngOf(1672, 941).toString('base64') }] }));
  const { items, onItem } = collector(1);
  await gen.runGeneration({ settings: makeSettings(tmpDir()), run: makeRun({ size: '1536x1024' }), signal: new AbortController().signal, onItem, fetchImpl });
  assert.equal(items[0].status, 'done', items[0].error);
  assert.equal(items[0].width, 1672);
  assert.equal(items[0].height, 941);
});

test('JPEG 按 EXIF 方向换算宽高（大端、小端）', () => {
  const sof = (w, h) => Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, ...Buffer.alloc(15)]);
  const exif = (orientation, le) => {
    const t = Buffer.alloc(26);
    t.write(le ? 'II' : 'MM', 0, 'ascii');
    const w16 = (v, o) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o));
    const w32 = (v, o) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o));
    w16(42, 2);
    w32(8, 4);
    w16(1, 8);
    w16(0x0112, 10);
    w16(3, 12);
    w32(1, 14);
    w16(orientation, 18);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
    const head = Buffer.from([0xff, 0xe1, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
  };
  const jpeg = (orientation, le) => Buffer.concat([Buffer.from([0xff, 0xd8]), exif(orientation, le), sof(1536, 1024), Buffer.alloc(8)]);
  assert.deepEqual(gen.imageSize(jpeg(6, false)), { width: 1024, height: 1536 });
  assert.deepEqual(gen.imageSize(jpeg(8, true)), { width: 1024, height: 1536 });
  assert.deepEqual(gen.imageSize(jpeg(3, true)), { width: 1536, height: 1024 });
  assert.deepEqual(gen.imageSize(jpeg(1, false)), { width: 1536, height: 1024 });

  // EXIF 后面紧跟一个 XMP 的 APP1 段，不能把已经读到的方向冲掉
  const xmpPayload = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>', 'latin1');
  const xmp = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), xmpPayload]);
  xmp.writeUInt16BE(xmpPayload.length + 2, 2);
  const withXmp = Buffer.concat([Buffer.from([0xff, 0xd8]), exif(6, true), xmp, sof(1536, 1024), Buffer.alloc(8)]);
  assert.deepEqual(gen.imageSize(withXmp), { width: 1024, height: 1536 });

  // EXIF 段在 SOF 之后（规范允许），扫到 SOS 之前都要读
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0]);
  const exifAfterSof = Buffer.concat([Buffer.from([0xff, 0xd8]), sof(32, 16).subarray(0, 19), exif(6, false), sos, Buffer.alloc(16)]);
  assert.deepEqual(gen.imageSize(exifAfterSof), { width: 16, height: 32 });
});

test('请求预览：草稿按现在的规则规范化，历史记录原样显示当时发送的内容', () => {
  const settings = makeSettings('/tmp', { agentsEnabled: true, agentsPrompt: 'A', sizeInPrompt: true });
  const draft = gen.preparePreview(settings, { prompt: '猫', size: '1024✖1536', model: 'm', inputs: [] });
  assert.equal(draft.size, '1024x1536');
  assert.equal(draft.finalPrompt, 'A\n\n猫\n\n输出图片尺寸为 1024x1536（竖版，2:3）。');
  assert.throws(() => gen.preparePreview(settings, { prompt: '猫', size: 'abc' }), /尺寸格式不对/);

  // 旧版本存下的不规范尺寸：原样显示，不报错，也不按现在的设置追加尺寸描述
  for (const size of ['1024X1536', 'abc']) {
    const old = gen.preparePreview(settings, { prompt: '猫', size, model: 'm', inputs: [], finalPrompt: '当时发送的提示词' });
    assert.equal(old.size, size);
    assert.equal(old.finalPrompt, '当时发送的提示词');
    const { text } = gen.previewRequest(settings, old);
    assert.match(text, new RegExp(`"size": "${size}"`));
    assert.match(text, /当时发送的提示词/);
  }
});

test('可选尺寸一次输入多个：标准写法规范化，其他整段原样保留', () => {
  const { splitSizeList } = require('../shared/size.mjs');
  assert.deepEqual(splitSizeList('1024 * 1536'), { sizes: ['1024x1536'], raw: [] });
  assert.deepEqual(splitSizeList('1024x1024 1536x1024'), { sizes: ['1024x1024', '1536x1024'], raw: [] });
  assert.deepEqual(splitSizeList('1024 * 1536 800x800'), { sizes: ['1024x1536', '800x800'], raw: [] });
  assert.deepEqual(splitSizeList('1024 * 1536，800✖800、auto\n2048x1152; 16：9'), {
    sizes: ['1024x1536', '800x800', 'auto', '2048x1152', '16:9'],
    raw: [],
  });
  // 服务商自定义的写法、输错的：整段原样保留，不改写、不截断、不拆开
  assert.deepEqual(splitSizeList('２K, 1:1 方图, 16:9999, 1024x1536x2'), { sizes: [], raw: ['２K', '1:1 方图', '16:9999', '1024x1536x2'] });
  assert.deepEqual(splitSizeList('abc, 16:9 1536x1024'), { sizes: ['16:9', '1536x1024'], raw: ['abc'] });
  assert.deepEqual(splitSizeList('  '), { sizes: [], raw: [] });
});

test('本次请求的尺寸：新输入要合规，旧版本存下的值原样发送', () => {
  const settings = makeSettings('/tmp', { sizes: ['1024x1024', '1:1 方图'], defaultSize: '旧默认' });
  assert.equal(gen.resolveRunSize(settings, '1536✖1024'), '1536x1024');
  assert.equal(gen.resolveRunSize(settings, '16:9'), '16:9');
  assert.equal(gen.resolveRunSize(settings, ''), '');
  assert.throws(() => gen.resolveRunSize(settings, 'abc'), /尺寸格式不对：abc/);
  // 设置里已经保存的旧值、默认尺寸、历史记录「重新生成」：原样使用
  assert.equal(gen.resolveRunSize(settings, '1:1 方图'), '1:1 方图');
  assert.equal(gen.resolveRunSize(settings, undefined), '旧默认');
  assert.equal(gen.resolveRunSize(settings, 'abc', { fromHistory: true }), 'abc');
  // 历史记录里认得但不规范的写法，重发时也原样发送，和「请求详情」显示的一致
  assert.equal(gen.resolveRunSize(settings, '1024X1536', { fromHistory: true }), '1024X1536');
  assert.equal(gen.resolveRunSize(settings, '1024X1536'), '1024x1536');
});

test('实际尺寸是否符合请求：像素完全一致，比例按宽高比（允许 2% 误差）', () => {
  const { sizeMatches } = require('../shared/size.mjs');
  const d = (width, height) => ({ width, height });
  assert.equal(sizeMatches('1536x1024', d(1536, 1024)), true);
  assert.equal(sizeMatches('1536x1024', d(1672, 941)), false);
  assert.equal(sizeMatches('16:9', d(1672, 941)), true);
  assert.equal(sizeMatches('16:9', d(1344, 768)), true);
  assert.equal(sizeMatches('16:9', d(1024, 1024)), false);
  assert.equal(sizeMatches('9:16', d(1672, 941)), false);
  assert.equal(sizeMatches('auto', d(1024, 1024)), null);
  assert.equal(sizeMatches('2K', d(2048, 2048)), null);
  assert.equal(sizeMatches('0x100', d(0, 100)), null);
  assert.equal(sizeMatches('1536x1024', null), null);
});

test('编辑后重试：没改过的历史尺寸原样预览和发送', () => {
  const settings = makeSettings('/tmp', { sizes: ['1024x1024'], defaultSize: '1024x1024', sizeInPrompt: true });
  assert.throws(() => gen.preparePreview(settings, { prompt: '猫', size: '2K' }), /尺寸格式不对/);
  const p = gen.preparePreview(settings, { prompt: '猫', size: '2K', fromHistory: true });
  assert.equal(p.size, '2K');
  assert.equal(p.finalPrompt, '猫');
  assert.equal(gen.resolveRunSize(settings, '2K', { fromHistory: true }), '2K');
});

test('全角写法：ＡＵＴＯ、全角数字和符号都能识别，认不出的原样保留', () => {
  const { normalizeSize, splitSizeList } = require('../shared/size.mjs');
  assert.equal(normalizeSize('ＡＵＴＯ'), 'auto');
  assert.equal(normalizeSize('１０２４＊１５３６'), '1024x1536');
  assert.equal(normalizeSize('１６：９'), '16:9');
  assert.equal(normalizeSize('２K'), null);
  assert.deepEqual(splitSizeList('ＡＵＴＯ，２K'), { sizes: ['auto'], raw: ['２K'] });
  assert.deepEqual(splitSizeList('１０２４ｘ１０２４　１６：９'), { sizes: ['1024x1024', '16:9'], raw: [] });
});

test('尺寸还能不能用：选中的非标准尺寸从设置里删掉后就不能用了', () => {
  const { isUsableSize } = require('../shared/size.mjs');
  const before = { sizes: ['1024x1024', '2K'], defaultSize: '1024x1024' };
  const after = { sizes: ['1024x1024'], defaultSize: '1024x1024' };
  assert.equal(isUsableSize('2K', before), true);
  assert.equal(isUsableSize('2K', after), false);
  assert.equal(isUsableSize('2K', after, { fromHistory: true }), true);
  assert.equal(isUsableSize('1536✖1024', after), true);
  assert.equal(isUsableSize('', after), true);
  // 主进程用的是同一条规则
  assert.equal(gen.resolveRunSize(makeSettings('/tmp', before), '2K'), '2K');
  assert.throws(() => gen.resolveRunSize(makeSettings('/tmp', after), '2K'), /尺寸格式不对/);
});
