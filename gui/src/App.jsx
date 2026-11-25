import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import Sidebar from './components/Sidebar.jsx';
import Workspace from './components/Workspace.jsx';
import SettingsPage from './components/Settings.jsx';
import Lightbox from './components/Lightbox.jsx';
import { ConfirmDialog, Modal, ToastProvider, useToast } from './components/ui.jsx';
import { api, titleFrom } from './lib.js';

function draftFromSettings(s) {
  return {
    prompt: '',
    attachments: [],
    maskPath: null,
    model: s.defaultModel,
    size: s.defaultSize,
    quality: s.defaultQuality,
    count: s.defaultCount,
    outName: '',
    perLine: false,
  };
}

const PARAM_KEYS = [
  ['model', 'defaultModel'],
  ['size', 'defaultSize'],
  ['quality', 'defaultQuality'],
  ['count', 'defaultCount'],
];

// 把生成参数换成设置里的默认值，保留已输入的提示词和参考图
function withDefaults(d, s) {
  const next = { ...d };
  for (const [k, sk] of PARAM_KEYS) next[k] = s[sk];
  return next;
}

// 保存设置后：草稿里还是旧默认值（没被手动改过）的参数，跟着换成新默认值
function followDefaults(d, prev, s) {
  const next = { ...d };
  for (const [k, sk] of PARAM_KEYS) if (d[k] === prev[sk]) next[k] = s[sk];
  return next;
}

function upsert(list, s) {
  const next = list.filter((x) => x.id !== s.id);
  next.push(s);
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

function RequestPreview({ data, onClose }) {
  const toast = useToast();
  return (
    <Modal
      title="请求预览（dry-run）"
      onClose={onClose}
      width={680}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await api.files.copyText(data.text);
              toast.success('已复制');
            }}
          >
            <Copy size={14} /> 复制
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <p className="muted small preview-summary">{data.summary}</p>
      <pre className="code-block">{data.text}</pre>
    </Modal>
  );
}

function AppInner() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [view, setView] = useState('work');
  const [draft, setDraft] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const settingsDirty = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const [s, list, info] = await Promise.all([api.settings.get(), api.history.list(), api.appInfo()]);
        setSettings(s);
        setDraft(draftFromSettings(s));
        setSessions(list);
        setAppInfo(info);
        if (!s.apiUrl || !s.apiKey) setView('settings');
      } catch (e) {
        toast.error(e.message);
      }
    })();
    const offS = api.history.onSession((s) => setSessions((l) => upsert(l, s)));
    const offR = api.history.onRemoved((id) => {
      setSessions((l) => l.filter((x) => x.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    });
    return () => {
      offS();
      offR();
    };
  }, [toast]);

  // 设置里删掉了当前选中的模型时，回退到默认模型
  useEffect(() => {
    if (!settings) return;
    setDraft((d) => (d && !settings.models.includes(d.model) ? { ...d, model: settings.defaultModel } : d));
  }, [settings]);

  const activeSession = useMemo(() => sessions.find((s) => s.id === activeId) || null, [sessions, activeId]);

  const ask = (opts) =>
    new Promise((resolve) => {
      setConfirm({
        ...opts,
        onConfirm: () => {
          setConfirm(null);
          resolve(true);
        },
        onCancel: () => {
          setConfirm(null);
          resolve(false);
        },
      });
    });

  // 离开设置页时检查未保存修改
  const leaveSettings = async () => {
    if (view === 'settings' && settingsDirty.current) {
      const ok = await ask({ title: '放弃未保存的修改？', message: '设置页还有修改没有保存。', confirmText: '放弃修改', danger: true });
      if (!ok) return false;
      settingsDirty.current = false;
    }
    return true;
  };

  const goSession = async (id) => {
    if (!(await leaveSettings())) return;
    setActiveId(id);
    setView('work');
  };

  const newTask = useCallback(async () => {
    if (!(await leaveSettings())) return;
    setActiveId(null);
    setView('work');
    if (settings) setDraft((d) => withDefaults(d, settings));
  }, [view, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSettingsSaved = (next) => {
    const prev = settings;
    setSettings(next);
    if (prev) setDraft((d) => (d ? followDefaults(d, prev, next) : d));
  };

  const openSettings = () => setView('settings');

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newTask();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setView('settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newTask]);

  const splitAttachments = (d) => {
    const mask = d.attachments.find((a) => a.path === d.maskPath) || null;
    const inputs = d.attachments.filter((a) => a.path !== d.maskPath);
    return { mask, inputs };
  };

  // 提交锁：连按 Enter 或双击发送时，不会重复发出同一批请求
  const submitting = useRef(false);

  const submit = async () => {
    if (submitting.current) return;
    const text = draft.prompt.trim();
    if (!text) return;
    if (!settings.apiUrl || !settings.apiKey) {
      toast.error('请先在设置中配置接口地址和 API Key');
      setView('settings');
      return;
    }
    const prompts = draft.perLine ? text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [text];
    const { mask, inputs } = splitAttachments(draft);
    if (mask && !inputs.length) {
      toast.error('蒙版需要配合至少一张原图使用');
      return;
    }
    const params = {
      model: draft.model,
      size: draft.size,
      quality: draft.quality,
      count: draft.count,
      outName: draft.outName,
      inputs,
      mask,
    };
    const sent = draft;
    submitting.current = true;
    try {
      let sid = activeId;
      if (!sid) {
        const s = await api.history.create(titleFrom(prompts[0]));
        sid = s.id;
        setActiveId(sid);
      }
      for (const p of prompts) await api.gen.start(sid, { ...params, prompt: p });
      // 只清掉这次提交的内容；提交过程中又输入或换了参考图的，保留新内容
      setDraft((d) => ({
        ...d,
        prompt: d.prompt === sent.prompt ? '' : d.prompt,
        attachments: d.attachments === sent.attachments ? [] : d.attachments,
        maskPath: d.attachments === sent.attachments ? null : d.maskPath,
        outName: d.outName === sent.outName ? '' : d.outName,
      }));
    } catch (e) {
      toast.error(e.message);
    } finally {
      submitting.current = false;
    }
  };

  const previewDraft = async () => {
    const { mask, inputs } = splitAttachments(draft);
    const firstLine = draft.perLine ? draft.prompt.split(/\r?\n/).find((s) => s.trim()) || '' : draft.prompt;
    try {
      setPreview(
        await api.gen.preview({
          prompt: firstLine,
          model: draft.model,
          size: draft.size,
          quality: draft.quality,
          count: draft.count,
          inputs,
          mask,
        }),
      );
    } catch (e) {
      toast.error(e.message);
    }
  };

  const previewRun = async (run) => {
    try {
      setPreview(await api.gen.preview({ ...run, finalPrompt: run.finalPrompt }));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const rerun = async (run) => {
    try {
      await api.gen.start(run.sessionId, {
        prompt: run.prompt,
        model: run.model,
        size: run.size,
        quality: run.quality,
        count: run.count,
        outName: run.outName,
        inputs: run.inputs,
        mask: run.mask,
      });
    } catch (e) {
      toast.error(e.message);
    }
  };

  const editRun = (run) => {
    setDraft((d) => ({
      ...d,
      prompt: run.prompt,
      attachments: [...run.inputs, ...(run.mask ? [run.mask] : [])],
      maskPath: run.mask?.path || null,
      model: run.model,
      size: run.size,
      quality: run.quality,
      count: run.count,
      outName: run.outName || '',
      perLine: false,
    }));
  };

  const deleteRun = async (run) => {
    const ok = await ask({
      title: '删除这条生成记录？',
      message: '只删除历史记录，已经保存到磁盘的图片不会被删除。',
      confirmText: '删除',
      danger: true,
    });
    if (ok) api.history.removeRun(run.sessionId, run.id).catch((e) => toast.error(e.message));
  };

  const deleteSession = async (s) => {
    const ok = await ask({
      title: '删除任务？',
      message: `「${s.title}」及其中的 ${s.runs.length} 条生成记录会被删除，已保存的图片文件不会被删除。`,
      confirmText: '删除',
      danger: true,
    });
    if (ok) api.history.remove(s.id).catch((e) => toast.error(e.message));
  };

  const useAsRef = async (p) => {
    try {
      const a = await api.files.importImagePath(p);
      setDraft((d) => (d.attachments.some((x) => x.path === a.path) ? d : { ...d, attachments: [...d.attachments, a] }));
      if (view !== 'work') setView('work');
      toast.info('已添加为参考图');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const openOutput = () => api.files.openDir().catch((e) => toast.error(e.message));

  if (!settings || !draft) return <div className="boot" />;

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        view={view}
        onSelect={goSession}
        onNew={newTask}
        onRename={(id, t) => api.history.rename(id, t).catch((e) => toast.error(e.message))}
        onDelete={deleteSession}
        onOpenSettings={openSettings}
        onOpenOutput={openOutput}
      />

      {view === 'settings' ? (
        <SettingsPage
          settings={settings}
          appInfo={appInfo}
          onSaved={onSettingsSaved}
          onDirtyChange={(d) => {
            settingsDirty.current = d;
          }}
          onBack={async () => {
            if (await leaveSettings()) setView('work');
          }}
        />
      ) : (
        <Workspace
          session={activeSession}
          settings={settings}
          draft={draft}
          setDraft={setDraft}
          onSubmit={submit}
          onPreviewRequest={previewDraft}
          onRunPreview={previewRun}
          onOpenImage={(paths, index) => paths.length && setLightbox({ paths, index: Math.max(0, index) })}
          onUseAsRef={useAsRef}
          onRerun={rerun}
          onEditRun={editRun}
          onDeleteRun={deleteRun}
          onOpenSettings={openSettings}
          onOpenOutput={openOutput}
        />
      )}

      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} onUseAsRef={useAsRef} />}
      {preview && <RequestPreview data={preview} onClose={() => setPreview(null)} />}
      {confirm && <ConfirmDialog {...confirm} />}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
