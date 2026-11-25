// img.sh 的集成测试：本地起一个假的生图接口，用 bash 实际运行脚本。
// img.sh 用到了 GNU 的 stat -c，只在 Linux 上跑；缺少 bash / curl / jq 时也跳过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { PNG_B64, tmpDir } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', '..', 'img.sh');
const hasTools = process.platform === 'linux' && ['bash', 'curl', 'jq'].every((cmd) => {
  try {
    execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
const opts = { skip: hasTools ? false : '只在装有 bash / curl / jq 的 Linux 上运行' };

// 假接口：按提示词里的关键字决定返回什么，并记录收到的请求
function startMock() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/files/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(PNG_B64, 'base64'));
    }
    if (req.url.startsWith('/html/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>Service Unavailable</html>');
    }
    if (req.url.startsWith('/missing/')) {
      res.writeHead(404);
      return res.end('not found');
    }
    let prompt;
    if (req.url.endsWith('/edits')) {
      const fd = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      prompt = fd.get('prompt');
      requests.push({ url: req.url, fields: [...fd.keys()], prompt });
    } else {
      prompt = JSON.parse(body.toString()).prompt;
      requests.push({ url: req.url, prompt });
    }
    if (prompt.includes('html')) return json({ data: [{ url: `${base}/html/x.png` }] });
    if (prompt.includes('404')) return json({ data: [{ url: `${base}/missing/x.png` }] });
    if (prompt.includes('url')) return json({ data: [{ url: `${base}/files/x.png` }] });
    if (prompt.includes('text')) return json({ data: [{ b64_json: Buffer.from('hello, not an image').toString('base64') }] });
    return json({ data: [{ b64_json: PNG_B64 }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

// 在临时目录里放一份 img.sh 和 img.config，输出也写在这个目录下
function setup(port) {
  const dir = tmpDir();
  fs.copyFileSync(SCRIPT, path.join(dir, 'img.sh'));
  fs.chmodSync(path.join(dir, 'img.sh'), 0o755);
  if (port) fs.writeFileSync(path.join(dir, 'img.config'), `url=http://127.0.0.1:${port}\ntoken=sk-test\n`);
  return dir;
}

function run(dir, args, env = {}) {
  return new Promise((resolve) => {
    execFile('bash', [path.join(dir, 'img.sh'), ...args], { cwd: dir, env: { ...process.env, ...env, NO_PROXY: '*', no_proxy: '*' } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

const outputs = (dir, sub = 'outputs') => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).sort() : []);

test('img.sh：没有 img.config 也能看帮助', opts, async () => {
  const dir = setup(null);
  const r = await run(dir, ['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /文生图/);
});

test('img.sh：正常保存 b64 和 url 两种返回', opts, async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const dir = setup(mock.port);
  assert.equal((await run(dir, ['正常'])).code, 0);
  assert.equal((await run(dir, ['url 下载'])).code, 0);
  assert.equal(outputs(dir).length, 2);
});

test('img.sh：网页、非图片 base64、404 都判为失败，不留文件', opts, async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const dir = setup(mock.port);
  for (const [prompt, want] of [
    ['html 错误页', /不是 PNG/],
    ['text 文本', /不是 PNG/],
    ['404 下载', /下载失败/],
  ]) {
    const r = await run(dir, [prompt]);
    assert.equal(r.code, 1, prompt);
    assert.match(r.stderr, want, prompt);
  }
  assert.deepEqual(outputs(dir), []);
});

test('img.sh：@ 开头的提示词按原文发送，不会被 curl 当成文件', opts, async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const dir = setup(mock.port);
  fs.writeFileSync(path.join(dir, 'ref.png'), Buffer.from(PNG_B64, 'base64'));
  const r = await run(dir, ['-i', 'ref.png', '@/etc/hostname 换背景']);
  assert.equal(r.code, 0, r.stderr);
  const req = mock.requests.at(-1);
  assert.equal(req.url, '/v1/images/edits');
  assert.equal(req.prompt, '@/etc/hostname 换背景');
});

test('img.sh：IMG_JOBS 校验', opts, async () => {
  const dir = setup(1);
  for (const jobs of ['0', '-1', 'abc']) {
    const r = await run(dir, ['x'], { IMG_JOBS: jobs });
    assert.equal(r.code, 1, jobs);
    assert.match(r.stderr, /IMG_JOBS/, jobs);
  }
});

test('img.sh：带点的目录名、同名文件不覆盖、同时启动多个实例', opts, async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  const dir = setup(mock.port);
  assert.equal((await run(dir, ['-n', '2', 'x', 'assets.v1/banner'])).code, 0);
  assert.deepEqual(outputs(dir, 'assets.v1'), ['banner-1.png', 'banner-2.png']);
  assert.equal((await run(dir, ['x', 'assets.v1/banner-1.png'])).code, 0);
  assert.deepEqual(outputs(dir, 'assets.v1'), ['banner-1 (2).png', 'banner-1.png', 'banner-2.png']);

  const rs = await Promise.all([1, 2, 3].map(() => run(dir, ['同时启动'])));
  assert.ok(rs.every((r) => r.code === 0));
  assert.equal(outputs(dir).length, 3, '同一秒启动的 3 个实例应写出 3 个不同的文件');
});
