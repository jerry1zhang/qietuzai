const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  appInfo: () => call('app:info'),

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
    keyStorage: () => call('settings:keyStorage'),
    forgetKey: () => call('settings:forgetKey'),
    fetchModels: (apiUrl, apiKey, proxy) => call('settings:fetchModels', apiUrl, apiKey, proxy),
    resolveEndpoint: (apiUrl) => call('settings:resolveEndpoint', apiUrl),
    importConfig: () => call('settings:importConfig'),
    pickDir: (current) => call('dialog:pickDir', current),
  },

  history: {
    list: () => call('history:list'),
    create: (title) => call('history:create', title),
    rename: (id, title) => call('history:rename', id, title),
    remove: (id) => call('history:delete', id),
    removeRun: (sessionId, runId) => call('history:deleteRun', sessionId, runId),
    onSession: (cb) => on('history:session', cb),
    onRemoved: (cb) => on('history:removed', cb),
  },

  gen: {
    start: (sessionId, params) => call('gen:start', sessionId, params),
    cancel: (runId) => call('gen:cancel', runId),
    preview: (params) => call('gen:preview', params),
  },

  files: {
    pickImages: () => call('files:pickImages'),
    importImageData: (name, data) => call('files:importImageData', name, data),
    importImagePath: (p) => call('files:importImagePath', p),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    },
    reveal: (p) => call('files:reveal', p),
    open: (p) => call('files:open', p),
    openDir: (dir) => call('files:openDir', dir),
    copyImage: (p) => call('files:copyImage', p),
    saveAs: (p) => call('files:saveAs', p),
    exists: (paths) => call('files:exists', paths),
    copyText: (text) => call('clipboard:writeText', text),
    startDrag: (p) => ipcRenderer.send('drag:start', p),
  },
});
