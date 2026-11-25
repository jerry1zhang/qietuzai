// 生图核心逻辑：从 img.sh 移植
// - 文生图 POST {base}/images/generations (JSON)
// - 图生图 POST {base}/images/edits (multipart，单图字段 image，多图字段 image[]，可选 mask)
// - 每次请求 n=1，按「数量」发送多次；所有任务共用设置里的并发数上限
// - 响应兼容 data/images/results 数组，图片字段兼容 b64_json/b64/image_base64/base64 和 url/image_url
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { net } = require('electron');
const { isUsableSize, normalizeSize, parseSize, parseRatio, sizeHintText: describeSize } = require('../shared/size.mjs');
// 报错和写进提示词的尺寸描述用当前界面语言（main.js 启动时和保存设置后设置）
const { t } = require('../shared/i18n.mjs');

const MAX_COUNT = 20;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// 归一化出 API 基础地址（去掉末尾的 /images/xxx，保证以 /v1 结尾）—— 与 img.sh 一致
function resolveApiBase(rawUrl) {
  let u = String(rawUrl || '').trim();
  if (!u) return '';
  if (/\/images\/(generations|edits)\/?$/.test(u)) u = u.replace(/\/images\/(generations|edits)\/?$/, '');
  else u = u.replace(/\/+$/, '');
  if (!/\/v1$/.test(u)) u += '/v1';
  return u;
}

function endpointFor(settings, isEdit) {
  const base = resolveApiBase(settings.apiUrl);
  return `${base}/images/${isEdit ? 'edits' : 'generations'}`;
}

// ---------- 尺寸 ----------
// 写进提示词的尺寸描述：有些中转接口忽略 size 参数，只认提示词里的描述
const sizeHintText = (size) => describeSize(size, t);

/**
 * 这次请求实际用的 size。
 * 新输入要符合尺寸规则；认不出的旧值（旧版本存进设置的，或者历史记录「重新生成」带过来的）原样发送，
 * 和以前的行为一致，不因为升级而突然不能用。
 */
function resolveRunSize(settings, input, { fromHistory = false } = {}) {
  const raw = String(input ?? settings.defaultSize ?? '').trim();
  // 历史记录里没改过的尺寸：当时发的什么就发什么（「请求详情」里显示的也是这个），不按现在的规则改写
  if (fromHistory) return raw;
  const size = normalizeSize(raw);
  if (size !== null) return size;
  if (isUsableSize(raw, settings)) return raw; // 设置里保存着的非标准写法
  throw new Error(t('size.badFormat', { size: raw, hint: t('size.formatHint') }));
}

function applyAgents(settings, prompt) {
  const agents = (settings.agentsPrompt || '').trim();
  if (settings.agentsEnabled && agents) return { finalPrompt: `${agents}\n\n${prompt}`, agentsApplied: true };
  return { finalPrompt: prompt, agentsApplied: false };
}

// 实际发送的提示词 = Agents 提示词 + 用户提示词 + 尺寸描述（设置里打开时）
function buildFinalPrompt(settings, prompt, size) {
  const { finalPrompt, agentsApplied } = applyAgents(settings, prompt);
  const sizeHint = settings.sizeInPrompt ? sizeHintText(size) : '';
  return { finalPrompt: sizeHint ? `${finalPrompt}\n\n${sizeHint}` : finalPrompt, agentsApplied, sizeHint };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '*'.repeat(key.length);
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// 按文件头识别图片格式，认不出时返回 null
function detectImageExt(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return null;
}

// JPEG 的 EXIF 方向（APP1 段里的 0x0112 标签）。不是 EXIF 段（比如 XMP）或没有这个标签时返回 null
function exifOrientation(buf, start, end) {
  if (buf.toString('ascii', start, start + 6) !== 'Exif\0\0') return null;
  const tiff = start + 6;
  const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const n = u16(ifd);
  for (let k = 0; k < n; k += 1) {
    const e = ifd + 2 + k * 12;
    if (e + 10 > end) break;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

// 从文件头读出图片宽高（JPEG 按 EXIF 方向换算成显示时的宽高），读不出时返回 null
function imageSize(buf) {
  try {
    const ext = detectImageExt(buf);
    if (ext === 'png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === 'gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (ext === 'webp' && buf.length >= 30) {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
    if (ext === 'jpg') {
      let i = 2;
      let orientation = 1;
      let frame = null;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) break; // 结构不对就停下，用已经读到的
        const marker = buf[i + 1];
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        // 到了图像数据（SOS）或文件尾，后面不会再有 EXIF 和帧头
        if (marker === 0xda || marker === 0xd9) break;
        // 只有读到方向标签才更新：EXIF 后面常跟一个 XMP 的 APP1 段，不能让它把方向冲掉
        if (marker === 0xe1) orientation = exifOrientation(buf, i + 4, Math.min(buf.length, i + 2 + buf.readUInt16BE(i + 2))) ?? orientation;
        // SOF0–SOF15（C4 / C8 / CC 不是帧头）里记录了宽高。EXIF 段可能在 SOF 之后，所以先记下来，扫完再换算
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          frame = { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      // EXIF 方向 5–8 表示要转 90°，宽高互换
      if (frame) return orientation >= 5 && orientation <= 8 ? { width: frame.height, height: frame.width } : frame;
    }
  } catch {
    /* 文件头不完整 */
  }
  return null;
}

function sniffExt(buf) {
  return detectImageExt(buf) || 'png';
}

// 严格解码 base64（兼容 data: 前缀、换行和 base64url）；Buffer.from 会悄悄跳过非法字符，不能直接用
function decodeBase64(text) {
  const clean = String(text)
    .replace(/^data:[^;,]+;base64,/, '')
    .replace(/\s+/g, '');
  if (!clean || clean.length % 4 === 1 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) {
    throw new Error(t('gen.badBase64', { data: truncate(clean, 60) }));
  }
  return Buffer.from(clean, /[-_]/.test(clean) ? 'base64url' : 'base64');
}

function mimeOf(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function scalarParams(run) {
  // 与 img.sh 一致：size 默认总是发送；quality 为空则不发送
  const p = { model: run.model, size: run.size || '', quality: run.quality || '' };
  return p;
}

// ---------- 请求体 ----------
async function buildBody(run) {
  const isEdit = run.inputs.length > 0;
  const { model, size, quality } = scalarParams(run);
  if (!isEdit) {
    const payload = { model, prompt: run.finalPrompt, n: 1 };
    if (size) payload.size = size;
    if (quality) payload.quality = quality;
    return { body: JSON.stringify(payload), contentType: 'application/json', payload };
  }
  // 手动拼 multipart：FormData 会把字段里的 \n 规范化成 \r\n，这里保证提示词原样发送（与 curl -F 一致）
  const parts = [];
  const field = run.inputs.length === 1 ? 'image' : 'image[]';
  for (const f of run.inputs) {
    parts.push({ name: field, filename: f.name || path.basename(f.path), type: mimeOf(f.path), data: await fsp.readFile(f.path) });
  }
  if (run.mask) {
    parts.push({ name: 'mask', filename: run.mask.name || path.basename(run.mask.path), type: mimeOf(run.mask.path), data: await fsp.readFile(run.mask.path) });
  }
  parts.push({ name: 'prompt', data: run.finalPrompt });
  parts.push({ name: 'model', data: model });
  parts.push({ name: 'n', data: '1' });
  if (size) parts.push({ name: 'size', data: size });
  if (quality) parts.push({ name: 'quality', data: quality });
  return encodeMultipart(parts);
}

function encodeMultipart(parts) {
  const boundary = `----qietuzai${crypto.randomBytes(12).toString('hex')}`;
  const esc = (v) => String(v).replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${esc(p.name)}"`;
    if (p.filename != null) head += `; filename="${esc(p.filename)}"\r\nContent-Type: ${p.type || 'application/octet-stream'}`;
    head += '\r\n\r\n';
    chunks.push(Buffer.from(head, 'utf8'), Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data), 'utf8'), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------- 「预览请求」（对应 --dry-run） ----------
// 输入框里的草稿：按当前设置规范化尺寸、拼出实际提示词。
// 历史记录的「请求详情」（带 finalPrompt）：原样使用当时记录的 size 和提示词，不按现在的规则改写。
function preparePreview(settings, params) {
  const prompt = String(params.prompt || '').trim() || t('gen.previewPrompt');
  const base = { ...params, prompt, count: Number(params.count) || 1, inputs: params.inputs || [], mask: params.mask || null };
  if (params.finalPrompt) return { ...base, size: params.size ?? '' };
  const size = resolveRunSize(settings, params.size, { fromHistory: Boolean(params.fromHistory) });
  return { ...base, size, finalPrompt: buildFinalPrompt(settings, prompt, size).finalPrompt };
}

function previewRequest(settings, run) {
  const isEdit = run.inputs.length > 0;
  const url = run.endpoint || endpointFor(settings, isEdit);
  const { model, size, quality } = scalarParams(run);
  const lines = [];
  lines.push(`POST ${url}`);
  lines.push(`Authorization: Bearer ${maskKey(settings.apiKey) || t('gen.notSet')}`);
  lines.push('Accept: application/json');
  if (!isEdit) {
    lines.push('Content-Type: application/json');
    lines.push('');
    const payload = { model, prompt: run.finalPrompt, n: 1 };
    if (size) payload.size = size;
    if (quality) payload.quality = quality;
    lines.push(JSON.stringify(payload, null, 2));
  } else {
    lines.push('Content-Type: multipart/form-data');
    lines.push('');
    const field = run.inputs.length === 1 ? 'image' : 'image[]';
    for (const f of run.inputs) lines.push(`${field}=@${f.path}`);
    if (run.mask) lines.push(`mask=@${run.mask.path}`);
    lines.push(`prompt=${run.finalPrompt}`);
    lines.push(`model=${model}`);
    lines.push('n=1');
    if (size) lines.push(`size=${size}`);
    if (quality) lines.push(`quality=${quality}`);
  }
  const jobs = Math.max(1, Math.min(Number(settings.concurrency) || 5, MAX_COUNT));
  const summary = t('gen.previewSummary', {
    mode: t(isEdit ? 'mode.edit' : 'mode.generate'),
    count: run.count,
    jobs,
    timeout: settings.timeoutSec || 600,
  });
  return { summary, text: lines.join('\n') };
}

// ---------- 输出命名 ----------
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sanitizeName(name) {
  return name.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim();
}

// 输出名里这些后缀当作扩展名处理；其他的（比如 banner.v2）算文件名的一部分
const NAME_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif']);

// 返回 { dir, base, ext|null }：ext 是用户写的扩展名，最终扩展名在写文件时按图片实际格式确定
function planOutput(settings, run) {
  const outRoot = settings.outputDir;
  let dir = outRoot;
  let base = `img-${stamp(new Date(run.createdAt))}`;
  let ext = null;
  const raw = (run.outName || '').trim();
  if (raw) {
    const target = path.isAbsolute(raw) ? raw : path.join(outRoot, raw);
    dir = path.dirname(target);
    const fileName = sanitizeName(path.basename(target));
    const e = path.extname(fileName);
    if (e && NAME_IMAGE_EXTS.has(e.slice(1).toLowerCase()) && fileName.length > e.length) {
      base = fileName.slice(0, -e.length);
      ext = e.slice(1).toLowerCase();
    } else {
      base = fileName || base;
    }
  }
  return { dir, base, ext };
}

// 写入图片，不覆盖已有文件（历史记录里引用的图片不能被覆盖）。
// 用排他创建（wx）选名：多个任务同时用同一个文件名时，也不会写到同一个路径上。
async function writeUnique(plan, index, count, bytes) {
  // 扩展名以图片实际格式为准：用户写的扩展名和实际格式一致才保留（jpg / jpeg 都算 JPEG），
  // 否则比如写了 banner.avif 却拿到 PNG，就存成 banner.png，保证能预览、能当参考图
  const actual = sniffExt(bytes);
  const ext = plan.ext && (plan.ext === actual || (actual === 'jpg' && plan.ext === 'jpeg')) ? plan.ext : actual;
  const stem = count === 1 ? plan.base : `${plan.base}-${index + 1}`;
  for (let k = 1; k < 10000; k += 1) {
    const candidate = path.join(plan.dir, k === 1 ? `${stem}.${ext}` : `${stem} (${k}).${ext}`);
    try {
      await fsp.writeFile(candidate, bytes, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      // 文件是这次新建的，写一半失败时删掉，不留下残缺图片
      await fsp.rm(candidate, { force: true }).catch(() => {});
      throw new Error(t('gen.saveFailed', { error: e.message }));
    }
  }
  throw new Error(t('gen.tooManySameName', { name: stem }));
}

// 所有任务共用的并发上限（设置里的「并发数」），按提交顺序排队
class Limiter {
  constructor(getMax) {
    this.getMax = getMax;
    this.active = 0;
    this.queue = [];
  }

  max() {
    return Math.max(1, Math.min(Number(this.getMax()) || 5, MAX_COUNT));
  }

  acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(t('gen.canceled')));
        return;
      }
      const entry = { resolve, signal, onAbort: null };
      entry.onAbort = () => {
        this.queue = this.queue.filter((x) => x !== entry);
        reject(new Error(t('gen.canceled')));
      };
      signal.addEventListener('abort', entry.onAbort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  release() {
    this.active -= 1;
    this.pump();
  }

  pump() {
    while (this.queue.length && this.active < this.max()) {
      const entry = this.queue.shift();
      entry.signal.removeEventListener('abort', entry.onAbort);
      this.active += 1;
      entry.resolve();
    }
  }
}

// ---------- 响应解析 ----------
function extractImage(json) {
  const list = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.images)
      ? json.images
      : Array.isArray(json?.results)
        ? json.results
        : [json];
  const item = list[0];
  if (item == null) return null;
  if (typeof item === 'string') {
    if (/^https?:\/\//i.test(item)) return { url: item };
    return { b64: item };
  }
  const b64 = item.b64_json || item.b64 || item.image_base64 || item.base64;
  const url = item.url || item.image_url;
  if (b64) return { b64: String(b64) };
  if (url) return { url: typeof url === 'string' ? url : url.url };
  return null;
}

function describeHttpError(status, text, json) {
  let msg = text;
  if (json) {
    const err = json.error ?? json;
    if (typeof err === 'string') msg = err;
    else if (err && typeof err.message === 'string') {
      msg = err.message;
      const extra = [err.type, err.code].filter(Boolean).join(' / ');
      if (extra) msg += ` (${extra})`;
    } else msg = JSON.stringify(err);
  }
  return `HTTP ${status}: ${truncate(msg, 400)}`;
}

function abortReason(signal, timeoutSec) {
  if (signal.reason?.name === 'TimeoutError') return t('gen.timeout', { sec: timeoutSec });
  return t('gen.canceled');
}

// 默认用 Electron 的网络栈（跟随系统代理）；测试时可以换成假的 fetch
const defaultFetch = (url, init) => net.fetch(url, init);

async function fetchOnce({ url, headers, body, signal, timeoutSec, fetchImpl = defaultFetch }) {
  const timeout = AbortSignal.timeout(timeoutSec * 1000);
  const combined = AbortSignal.any([signal, timeout]);
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body, signal: combined });
  } catch (e) {
    if (combined.aborted) throw new Error(signal.aborted ? t('gen.canceled') : t('gen.timeout', { sec: timeoutSec }));
    throw new Error(t('gen.requestFailed', { error: truncate(e.message || e, 300) }));
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    if (combined.aborted) throw new Error(signal.aborted ? t('gen.canceled') : t('gen.timeout', { sec: timeoutSec }));
    throw new Error(t('gen.readFailed', { error: truncate(e.message || e, 300) }));
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw new Error(describeHttpError(res.status, text, json));
  if (!json) throw new Error(t('gen.parseFailed', { text: truncate(text, 300) }));
  return json;
}

async function download(url, signal, fetchImpl = defaultFetch) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(300 * 1000)]);
  let res;
  try {
    res = await fetchImpl(url, { signal: combined });
  } catch (e) {
    if (combined.aborted) throw new Error(abortReason(combined, 300));
    throw new Error(t('gen.downloadFailed', { error: truncate(e.message || e, 200) }));
  }
  if (!res.ok) throw new Error(t('gen.downloadHttp', { status: res.status, url: truncate(url, 200) }));
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 执行一次生图任务。
 * onItem(index, patch) 在每张图状态变化时回调。
 * limiter 由调用方传入并在所有任务间共享；不传时只限制本次任务内的并发。
 */
async function runGeneration({ settings, run, signal, onItem, limiter, fetchImpl = defaultFetch }) {
  const isEdit = run.inputs.length > 0;
  const url = endpointFor(settings, isEdit);
  const timeoutSec = Math.max(10, Number(settings.timeoutSec) || 600);
  const lim = limiter || new Limiter(() => settings.concurrency);
  const plan = planOutput(settings, run);
  await fsp.mkdir(plan.dir, { recursive: true });

  const { body, contentType } = await buildBody(run);
  const headers = {
    Authorization: `Bearer ${settings.apiKey}`,
    Accept: 'application/json',
    'Content-Type': contentType,
  };
  const worker = async (i) => {
    try {
      await lim.acquire(signal);
    } catch {
      onItem(i, { status: 'canceled', error: t('gen.canceled') });
      return;
    }
    try {
      await generateOne(i);
    } finally {
      lim.release();
    }
  };

  const generateOne = async (i) => {
    const t0 = Date.now();
    onItem(i, { status: 'running', startedAt: t0 });
    try {
      const json = await fetchOnce({ url, headers, body, signal, timeoutSec, fetchImpl });
      const img = extractImage(json);
      if (!img) throw new Error(t('gen.noImage', { json: truncate(JSON.stringify(json), 300) }));
      const bytes = img.b64 ? decodeBase64(img.b64) : await download(img.url, signal, fetchImpl);
      if (!detectImageExt(bytes)) {
        const preview = truncate(bytes.toString('latin1').replace(/[^\x20-\x7e]/g, '.'), 60);
        throw new Error(t('gen.notImage', { bytes: bytes.length, preview }));
      }
      const target = await writeUnique(plan, i, run.count, bytes);
      const dims = imageSize(bytes);
      onItem(i, {
        status: 'done',
        path: target,
        bytes: bytes.length,
        ...(dims && { width: dims.width, height: dims.height }),
        mime: MIME_BY_EXT[path.extname(target).toLowerCase()] || 'image/png',
        ms: Date.now() - t0,
      });
    } catch (e) {
      const canceled = signal.aborted;
      onItem(i, { status: canceled ? 'canceled' : 'error', error: e.message || String(e), ms: Date.now() - t0 });
    }
  };

  await Promise.all(Array.from({ length: run.count }, (_, i) => worker(i)));
}

// GET {base}/models，用于设置页「从接口获取模型」和「测试连接」
async function listModels(apiUrl, apiKey, fetchImpl = defaultFetch) {
  const base = resolveApiBase(apiUrl);
  if (!base) throw new Error(t('gen.needApiUrl'));
  const res = await fetchImpl(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(describeHttpError(res.status, text, json));
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

module.exports = {
  MAX_COUNT,
  resolveApiBase,
  endpointFor,
  applyAgents,
  buildFinalPrompt,
  normalizeSize,
  parseSize,
  parseRatio,
  resolveRunSize,
  sizeHintText,
  imageSize,
  previewRequest,
  preparePreview,
  runGeneration,
  Limiter,
  extractImage,
  decodeBase64,
  detectImageExt,
  listModels,
  sniffExt,
  mimeOf,
};
