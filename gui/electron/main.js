const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  nativeImage,
  nativeTheme,
  protocol,
  net,
  session,
} = require('electron');
const { SettingsStore, HistoryStore, uid } = require('./store');
const gen = require('./generator');

const isDev = process.argv.includes('--dev');
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// 渲染进程通过 qtz://img/?p=<绝对路径> 读取本地图片
protocol.registerSchemesAsPrivileged([
  { scheme: 'qtz', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let settings = null;
let history = null;
const running = new Map(); // runId -> AbortController
// 所有任务共用一个并发上限；改了设置里的并发数后立即生效
const limiter = new gen.Limiter(() => settings.get().concurrency);

const THEME_BG = { dark: '#181818', light: '#ffffff' };
const THEME_FG = { dark: '#e8e8e8', light: '#1f1f1f' };

function currentTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function createWindow() {
  const theme = currentTheme();
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: '切图仔',
    backgroundColor: THEME_BG[theme],
    autoHideMenuBar: true,
    titleBarStyle: isMac ? 'hiddenInset' : isWin ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    titleBarOverlay: isWin ? { color: THEME_BG[theme], symbolColor: THEME_FG[theme], height: 48 } : undefined,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 外链用系统浏览器打开；禁止页面跳走（例如把文件拖进窗口）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isDev && url.startsWith('http://127.0.0.1:5173')) return;
    e.preventDefault();
  });

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  win.on('closed', () => {
    win = null;
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function emitSession(s) {
  if (s) send('history:session', s);
}

function applyTheme() {
  nativeTheme.themeSource = settings.get().theme;
}

function updateTitleBarOverlay() {
  if (!isWin || !win) return;
  const t = currentTheme();
  try {
    win.setTitleBarOverlay({ color: THEME_BG[t], symbolColor: THEME_FG[t], height: 48 });
  } catch {
    /* 旧版本 Windows 不支持时忽略 */
  }
}

async function applyProxy() {
  const proxy = settings.get().proxy;
  await session.defaultSession.setProxy(proxy ? { proxyRules: proxy } : { mode: 'system' });
}

// ---------------- 输入图片：统一复制到 userData/inputs，保证历史记录长期有效 ----------------
function inputsDir() {
  return path.join(app.getPath('userData'), 'inputs');
}

async function storeInputBuffer(buf, name) {
  let ext = path.extname(name || '').toLowerCase();
  if (!IMAGE_EXTS.has(ext)) ext = `.${gen.sniffExt(buf)}`;
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const dir = inputsDir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${hash}${ext}`);
  if (!fs.existsSync(target)) await fsp.writeFile(target, buf);
  return { path: target, name: name || path.basename(target) };
}

async function storeInputFile(file) {
  const buf = await fsp.readFile(file);
  return storeInputBuffer(buf, path.basename(file));
}

// ---------------- 生图任务 ----------------
function validateParams(p, cfg) {
  if (!cfg.apiUrl) throw new Error('请先在设置中填写接口地址');
  if (!cfg.apiKey) throw new Error('请先在设置中填写 API Key');
  const prompt = String(p.prompt || '').trim();
  if (!prompt) throw new Error('提示词不能为空');
  const count = Number.parseInt(p.count, 10);
  if (!Number.isFinite(count) || count < 1) throw new Error('数量必须 >= 1');
  if (count > gen.MAX_COUNT) throw new Error(`一次最多 ${gen.MAX_COUNT} 张`);
  const inputs = (p.inputs || []).map((f) => ({ path: f.path, name: f.name || path.basename(f.path) }));
  for (const f of inputs) if (!fs.existsSync(f.path)) throw new Error(`原图不存在: ${f.path}`);
  const mask = p.mask ? { path: p.mask.path, name: p.mask.name || path.basename(p.mask.path) } : null;
  if (mask && !inputs.length) throw new Error('蒙版需要配合原图使用');
  if (mask && !fs.existsSync(mask.path)) throw new Error(`蒙版不存在: ${mask.path}`);
  const model = String(p.model || cfg.defaultModel || 'gpt-image-1').trim();
  const size = gen.resolveRunSize(cfg, p.size, { fromHistory: Boolean(p.fromHistory) });
  return {
    prompt,
    count,
    inputs,
    mask,
    model,
    size,
    quality: String(p.quality ?? '').trim(),
    outName: String(p.outName || '').trim(),
  };
}

function makeRun(sessionId, p, cfg) {
  const { finalPrompt, agentsApplied, sizeHint } = gen.buildFinalPrompt(cfg, p.prompt, p.size);
  return {
    id: uid(),
    sessionId,
    createdAt: Date.now(),
    finishedAt: null,
    status: 'running',
    mode: p.inputs.length ? 'edit' : 'generate',
    prompt: p.prompt,
    finalPrompt,
    agentsApplied,
    sizeHint,
    model: p.model,
    size: p.size,
    quality: p.quality,
    count: p.count,
    outName: p.outName,
    inputs: p.inputs,
    mask: p.mask,
    endpoint: gen.endpointFor(cfg, p.inputs.length > 0),
    items: Array.from({ length: p.count }, (_, i) => ({ index: i, status: 'pending' })),
  };
}

async function startRun(sessionId, raw) {
  const cfg = settings.get();
  const p = validateParams(raw, cfg);
  const run = makeRun(sessionId, p, cfg);
  const s = history.addRun(sessionId, run);
  emitSession(s);

  const ctrl = new AbortController();
  running.set(run.id, ctrl);
  (async () => {
    try {
      await gen.runGeneration({
        settings: cfg,
        run,
        signal: ctrl.signal,
        limiter,
        onItem: (i, patch) => {
          Object.assign(run.items[i], patch);
          history.saveSoon();
          emitSession(history.get(sessionId));
        },
      });
    } catch (e) {
      // 请求发出之前就失败（例如读取原图失败）
      for (const it of run.items) {
        if (it.status === 'pending' || it.status === 'running') {
          it.status = 'error';
          it.error = e.message || String(e);
        }
      }
    } finally {
      running.delete(run.id);
      run.finishedAt = Date.now();
      const ok = run.items.filter((x) => x.status === 'done').length;
      if (ctrl.signal.aborted) run.status = 'canceled';
      else run.status = ok === run.count ? 'done' : ok > 0 ? 'partial' : 'error';
      history.saveSoon();
      emitSession(history.get(sessionId));
    }
  })();
  return run;
}

// ---------------- IPC ----------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

function assertImagePath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('无效路径');
  return p;
}

function registerIpc() {
  handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    userData: app.getPath('userData'),
  }));
  handle('settings:keyStorage', () => settings.keyStorage);

  // 设置
  handle('settings:get', () => settings.get());
  handle('settings:save', async (patch) => {
    const next = await settings.save(patch || {});
    limiter.pump(); // 调大并发数后，排队中的请求马上开始
    applyTheme();
    await applyProxy();
    return next;
  });
  handle('settings:fetchModels', async (apiUrl, apiKey, proxy) => {
    const want = String(proxy ?? settings.get().proxy).trim();
    if (want === settings.get().proxy) return gen.listModels(apiUrl, apiKey);
    // 表单里的代理还没保存：用一个单独的临时 session 测试，不影响正在跑的生成任务
    const ses = session.fromPartition('proxy-test', { cache: false });
    await ses.setProxy(want ? { proxyRules: want } : { mode: 'system' });
    await ses.closeAllConnections();
    return gen.listModels(apiUrl, apiKey, (u, o) => ses.fetch(u, o));
  });
  handle('settings:resolveEndpoint', (apiUrl) => {
    const base = gen.resolveApiBase(apiUrl);
    return base ? { generations: `${base}/images/generations`, edits: `${base}/images/edits` } : null;
  });
  handle('settings:importConfig', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择 img.config',
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const text = await fsp.readFile(r.filePaths[0], 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      out[m[1]] = v; // 与 img.sh 一致：同名 key 以最后一个为准
    }
    return out;
  });
  handle('dialog:pickDir', async (current) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择图片保存目录',
      defaultPath: current || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 历史
  handle('history:list', () => history.list());
  handle('history:create', (title) => {
    const s = history.create(String(title || '').slice(0, 60));
    emitSession(s);
    return s;
  });
  handle('history:rename', (id, title) => {
    const s = history.rename(id, title);
    emitSession(s);
    return s;
  });
  handle('history:delete', (id) => {
    const s = history.get(id);
    for (const r of s?.runs || []) running.get(r.id)?.abort();
    history.remove(id);
    send('history:removed', id);
    return true;
  });
  handle('history:deleteRun', (sessionId, runId) => {
    running.get(runId)?.abort();
    const s = history.removeRun(sessionId, runId);
    emitSession(s);
    return true;
  });

  // 生图
  handle('gen:start', (sessionId, params) => startRun(sessionId, params));
  handle('gen:cancel', (runId) => {
    running.get(runId)?.abort();
    return true;
  });
  handle('gen:preview', (params) => {
    const cfg = settings.get();
    return gen.previewRequest(cfg, gen.preparePreview(cfg, params));
  });

  // 文件
  handle('files:pickImages', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择参考图',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(storeInputFile));
  });
  handle('files:importImageData', async (name, data) => {
    const buf = Buffer.from(data);
    if (!buf.length) throw new Error('空文件');
    return storeInputBuffer(buf, name);
  });
  handle('files:importImagePath', async (p) => storeInputFile(assertImagePath(p)));
  handle('files:reveal', (p) => {
    shell.showItemInFolder(assertImagePath(p));
    return true;
  });
  handle('files:open', async (p) => {
    const err = await shell.openPath(assertImagePath(p));
    if (err) throw new Error(err);
    return true;
  });
  handle('files:openDir', async (dir) => {
    const target = dir || settings.get().outputDir;
    await fsp.mkdir(target, { recursive: true });
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return true;
  });
  handle('files:copyImage', (p) => {
    const img = nativeImage.createFromPath(assertImagePath(p));
    if (img.isEmpty()) throw new Error('该图片格式不支持复制到剪贴板');
    clipboard.writeImage(img);
    return true;
  });
  handle('files:saveAs', async (p) => {
    assertImagePath(p);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.basename(p) });
    if (r.canceled || !r.filePath) return null;
    await fsp.copyFile(p, r.filePath);
    return r.filePath;
  });
  handle('files:exists', (paths) => (paths || []).map((p) => typeof p === 'string' && fs.existsSync(p)));
  handle('clipboard:writeText', (text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  // 把生成的图片直接拖到其他软件（Figma / PS / Finder…）
  ipcMain.on('drag:start', (event, p) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return;
    let icon = nativeImage.createFromPath(p);
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
    else icon = icon.resize({ width: 96 });
    event.sender.startDrag({ file: p, icon });
  });
}

function registerProtocol() {
  protocol.handle('qtz', (req) => {
    const u = new URL(req.url);
    const p = u.searchParams.get('p') || '';
    if (!path.isAbsolute(p) || !IMAGE_EXTS.has(path.extname(p).toLowerCase())) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(p).toString());
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  settings = await SettingsStore.load(dataDir);
  history = new HistoryStore(dataDir);
  applyTheme();
  await applyProxy().catch(() => {});
  nativeTheme.on('updated', updateTitleBarOverlay);
  registerProtocol();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  for (const c of running.values()) c.abort();
  history?.flush();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
