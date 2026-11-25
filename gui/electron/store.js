// 设置与历史记录的本地持久化（userData 目录下的 JSON 文件）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');
const { normalizeSize } = require('./generator');
const { isLocale, t } = require('../shared/i18n.mjs');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 先写临时文件再 rename，避免写一半时崩溃导致文件损坏。
// 文件权限设为仅当前用户可读写（Windows 上 chmod 不起作用，靠用户目录本身的权限）。
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* 不支持 chmod 的文件系统 */
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Linux 上没有可用的钥匙串时，safeStorage 只是用固定密钥做简单加密
function weakBackend() {
  if (process.platform !== 'linux') return false;
  try {
    return ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend());
  } catch {
    return false;
  }
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------- 设置 ----------------
function defaultSettings() {
  return {
    apiUrl: '',
    apiKey: '',
    models: ['gpt-image-1'],
    defaultModel: 'gpt-image-1',
    sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
    defaultSize: '1024x1024',
    qualities: ['auto', 'high', 'medium', 'low'],
    defaultQuality: '',
    defaultCount: 1,
    concurrency: 5,
    timeoutSec: 600,
    agentsEnabled: true,
    agentsPrompt: '',
    sizeInPrompt: false, // 把尺寸描述写进提示词（应对忽略 size 参数的接口）
    // 不在 Electron 里（单元测试）时没有 app，用主目录代替
    outputDir: path.join(app?.getPath ? app.getPath('pictures') : os.homedir(), '切图仔'),
    proxy: '',
    theme: 'system',
    language: 'system', // 界面语言：system 跟随系统，或者 zh-CN、en 这样的语言代码
  };
}

class SettingsStore {
  constructor(file, data) {
    this.file = file;
    this.data = data;
    // API Key 的保存方式：none（没填）/ keychain（系统钥匙串加密）/ basic（简单加密）/ plain（明文）/
    // locked（有保存的 Key，但钥匙串暂时解不开）
    this.keyStorage = 'none';
    this.safe = safeStorage; // 测试时换成假的加密实现
    this.saving = Promise.resolve();
    // 上次写入文件的密文和它对应的 Key：Key 没变就沿用，不重新加密。
    // 否则只改了别的设置（比如切换语言）时，碰上钥匙串暂时不可用，会把原来的密文降级成明文
    this.keyEnc = null;
    this.keyEncFor = null;
    // 启动时没能解密的密文（钥匙串暂时不可用等）和当时的接口地址：Key 还空着、接口地址也没改时原样留在文件里，
    // 钥匙串恢复后下次启动还能解开。用户填了新 Key 或者换了接口地址就丢掉，免得旧服务的 Key 被发给新地址
    this.keyEncUnreadable = null;
  }

  static async load(dir) {
    const file = path.join(dir, 'settings.json');
    const raw = readJson(file, {});
    const { apiKeyEnc, ...rest } = raw;
    const data = { ...defaultSettings(), ...rest };
    let unreadable = null;
    // 旧版本或加密不可用时明文保存的 Key，这次能加密就顺便迁移
    let reEncrypt = Boolean(rest.apiKey) && !apiKeyEnc;
    if (apiKeyEnc) {
      try {
        const r = await safeStorage.decryptStringAsync(Buffer.from(apiKeyEnc, 'base64'));
        data.apiKey = r.result;
        reEncrypt = r.shouldReEncrypt;
      } catch {
        data.apiKey = ''; // 钥匙串变化导致无法解密时，需要重新填写
        unreadable = apiKeyEnc;
      }
    }
    const store = new SettingsStore(file, normalizeSettings(data));
    if (unreadable) store.keyEncUnreadable = { enc: unreadable, apiUrl: store.data.apiUrl };
    if (apiKeyEnc && data.apiKey && !reEncrypt) {
      store.keyEnc = apiKeyEnc;
      store.keyEncFor = store.data.apiKey;
    }
    if (reEncrypt) await store.save({});
    else if (store.keyEncUnreadable) store.keyStorage = 'locked';
    else if (apiKeyEnc && data.apiKey) store.keyStorage = weakBackend() ? 'basic' : 'keychain';
    else if (data.apiKey) store.keyStorage = 'plain';
    return store;
  }

  get() {
    return { ...this.data };
  }

  // 保存一个个排队执行：加密 Key 要等异步结果，两次保存交错时（比如切换语言的自动保存和点「保存」），
  // 先发出的那次可能后写完，用旧内容把新设置覆盖掉
  save(patch, opts) {
    const run = this.saving.then(() => this.saveNow(patch, opts));
    this.saving = run.catch(() => {});
    return run;
  }

  // 删掉解不开的旧 Key（设置页 API Key 一栏的「删除」）
  forgetUnreadableKey() {
    return this.save({}, { dropUnreadable: true });
  }

  // 先算好要写的内容，写盘成功后才更新内存：写盘失败时内存还是旧设置，下次保存不会把这次失败的改动带进去
  async saveNow(patch, { dropUnreadable = false } = {}) {
    const next = normalizeSettings({ ...this.data, ...patch });
    const { apiKey, ...rest } = next;
    const out = { ...rest };
    // API Key 尽量用系统钥匙串加密保存。不可用时退回明文（和 img.sh 的 img.config 一样），
    // 文件权限仅当前用户可读，设置页会明确提示当前的保存方式。
    let enc = null;
    if (apiKey && apiKey === this.keyEncFor) enc = this.keyEnc;
    else if (apiKey) {
      try {
        if (await this.safe.isAsyncEncryptionAvailable()) enc = (await this.safe.encryptStringAsync(apiKey)).toString('base64');
      } catch {
        enc = null;
      }
    }
    const unreadable = !apiKey && !dropUnreadable && this.keyEncUnreadable?.apiUrl === next.apiUrl ? this.keyEncUnreadable : null;
    if (enc) out.apiKeyEnc = enc;
    else if (apiKey) out.apiKey = apiKey;
    else if (unreadable) out.apiKeyEnc = unreadable.enc;
    writeJsonAtomic(this.file, out);
    this.data = next;
    this.keyEncUnreadable = unreadable;
    this.keyEnc = enc;
    this.keyEncFor = enc ? apiKey : null;
    this.keyStorage = !apiKey ? (unreadable ? 'locked' : 'none') : enc ? (weakBackend() ? 'basic' : 'keychain') : 'plain';
    return this.get();
  }
}

function uniqStrings(list) {
  const seen = new Set();
  const out = [];
  for (const s of list || []) {
    const v = String(s ?? '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// 保存目录统一转成绝对路径：支持 ~ 开头，其他相对路径按用户主目录解析
function resolveDir(p) {
  let dir = String(p || '').trim();
  if (!dir) return '';
  if (dir === '~' || /^~[\\/]/.test(dir)) dir = path.join(os.homedir(), dir.slice(1));
  return path.resolve(os.homedir(), dir);
}

// 旧设置里列表字段可能是字符串（手改过 settings.json 等），按逗号、换行拆开；其他类型当作空列表
function toList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/[,，\n]+/);
  return [];
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function normalizeSettings(s) {
  const d = defaultSettings();
  const out = { ...s };
  out.apiUrl = String(out.apiUrl || '').trim();
  out.apiKey = String(out.apiKey || '').trim();
  out.models = uniqStrings(toList(out.models));
  if (!out.models.length) out.models = [...d.models];
  if (!out.models.includes(out.defaultModel)) out.defaultModel = out.models[0];
  // 能识别的尺寸统一写法；认不出的旧值原样保留：旧版本允许任意写法，不能升级后被悄悄改掉或丢掉
  const fixSize = (v) => {
    const raw = String(v ?? '').trim();
    return normalizeSize(raw) ?? raw;
  };
  out.sizes = uniqStrings(toList(out.sizes).map(fixSize));
  if (!out.sizes.length) out.sizes = [...d.sizes];
  out.defaultSize = fixSize(out.defaultSize);
  out.qualities = uniqStrings(toList(out.qualities));
  out.defaultQuality = String(out.defaultQuality ?? '').trim();
  out.defaultCount = clampInt(out.defaultCount, 1, 20, 1);
  out.concurrency = clampInt(out.concurrency, 1, 20, 5);
  out.timeoutSec = clampInt(out.timeoutSec, 10, 3600, 600);
  out.agentsEnabled = Boolean(out.agentsEnabled);
  out.agentsPrompt = String(out.agentsPrompt || '');
  out.sizeInPrompt = Boolean(out.sizeInPrompt);
  out.outputDir = resolveDir(out.outputDir) || d.outputDir;
  out.proxy = String(out.proxy || '').trim();
  if (!['system', 'light', 'dark'].includes(out.theme)) out.theme = 'system';
  if (out.language !== 'system' && !isLocale(out.language)) out.language = 'system';
  return out;
}

// ---------------- 历史记录 ----------------
class HistoryStore {
  constructor(dir) {
    this.file = path.join(dir, 'history.json');
    const raw = readJson(this.file, { sessions: [] });
    this.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    this.timer = null;
    // 上次退出时还在跑的任务标记为中断
    let dirty = false;
    for (const s of this.sessions) {
      for (const r of s.runs || []) {
        if (r.status === 'running') {
          r.status = 'interrupted';
          r.finishedAt = r.finishedAt || Date.now();
          for (const it of r.items || []) {
            if (it.status === 'pending' || it.status === 'running') {
              it.status = 'error';
              it.error = t('main.interrupted');
            }
          }
          dirty = true;
        }
      }
    }
    if (dirty) this.flush();
  }

  list() {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.sessions.find((s) => s.id === id) || null;
  }

  create(title) {
    const now = Date.now();
    const s = { id: uid(), title: title || t('session.untitled'), createdAt: now, updatedAt: now, runs: [] };
    this.sessions.push(s);
    this.saveSoon();
    return s;
  }

  rename(id, title) {
    const s = this.get(id);
    if (!s) return null;
    s.title = String(title || '').trim() || s.title;
    this.saveSoon();
    return s;
  }

  remove(id) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const [s] = this.sessions.splice(i, 1);
    this.saveSoon();
    return s;
  }

  addRun(sessionId, run) {
    const s = this.get(sessionId);
    if (!s) throw new Error(t('main.noSession'));
    s.runs.push(run);
    s.updatedAt = Date.now();
    this.saveSoon();
    return s;
  }

  findRun(runId) {
    for (const s of this.sessions) {
      const r = (s.runs || []).find((x) => x.id === runId);
      if (r) return { session: s, run: r };
    }
    return null;
  }

  removeRun(sessionId, runId) {
    const s = this.get(sessionId);
    if (!s) return null;
    s.runs = s.runs.filter((r) => r.id !== runId);
    this.saveSoon();
    return s;
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    writeJsonAtomic(this.file, { version: 1, sessions: this.sessions });
  }
}

module.exports = { SettingsStore, HistoryStore, uid, defaultSettings, normalizeSettings };
