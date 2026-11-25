// 测试用的假接口和公共数据：不发真实网络请求
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 报错信息等按简体中文断言
require('../shared/i18n.mjs').setLocale('zh-CN');

// 只需要文件头能被识别成 PNG
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);
const PNG_B64 = PNG.toString('base64');

const created = [];
process.on('exit', () => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qietuzai-test-'));
  created.push(d);
  return d;
}

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/**
 * 假的 fetch：记录同时进行中的请求数，支持 AbortSignal。
 * respond(url, init) 返回 Response（或 Promise<Response>）。
 */
function fakeApi(respond, { delay = 20 } = {}) {
  const stats = { inflight: 0, max: 0, calls: [] };
  const fetchImpl = (url, init = {}) =>
    new Promise((resolve, reject) => {
      stats.calls.push({ url, init });
      stats.inflight += 1;
      stats.max = Math.max(stats.max, stats.inflight);
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        stats.inflight -= 1;
        return true;
      };
      const timer = setTimeout(async () => {
        if (!finish()) return;
        try {
          resolve(await respond(url, init));
        } catch (e) {
          reject(e);
        }
      }, delay);
      init.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          if (finish()) reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  return { fetchImpl, stats };
}

function makeSettings(outputDir, patch = {}) {
  return { apiUrl: 'http://api.test', apiKey: 'sk-test', outputDir, concurrency: 5, timeoutSec: 60, ...patch };
}

function makeRun(patch = {}) {
  return {
    createdAt: Date.now(),
    finalPrompt: '一只猫',
    model: 'gpt-image-1',
    size: '1024x1024',
    quality: '',
    count: 1,
    outName: '',
    inputs: [],
    mask: null,
    ...patch,
  };
}

// 收集每张图的最终状态
function collector(count) {
  const items = Array.from({ length: count }, (_, index) => ({ index, status: 'pending' }));
  return { items, onItem: (i, patch) => Object.assign(items[i], patch) };
}

module.exports = { PNG, PNG_B64, tmpDir, jsonResponse, fakeApi, makeSettings, makeRun, collector };
