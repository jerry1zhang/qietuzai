import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import Sidebar from './components/Sidebar.jsx';
import Workspace from './components/Workspace.jsx';
import SettingsPage from './components/Settings.jsx';
import Lightbox from './components/Lightbox.jsx';
import { ConfirmDialog, Modal, ToastProvider, useToast } from './components/ui.jsx';
import { api, titleFrom } from './lib.js';
import { draftAfterSettingsSaved, draftFromSettings, sizeFromHistory, withDefaults } from './draft.mjs';
import { createTranslator, I18nProvider, resolveLocale, useT } from './i18n.jsx';

function upsert(list, s) {
  const next = list.filter((x) => x.id !== s.id);
  next.push(s);
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

function RequestPreview({ data, onClose }) {
  const toast = useToast();
  const t = useT();
  return (
    <Modal
      title={t('app.previewTitle')}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await api.files.copyText(data.text);
              toast.success(t('common.copied'));
            }}
          >
            <Copy size={14} /> {t('common.copy')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('common.close')}
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

  // 界面语言：设置里选的，或者跟随系统（主进程给出系统语言列表，还没拿到时先用浏览器的）
  const locale = resolveLocale(settings?.language, appInfo?.systemLanguages || navigator.languages);
  const t = useMemo(() => createTranslator(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

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
      const ok = await ask({ title: t('app.discardTitle'), message: t('app.discardMessage'), confirmText: t('app.discardConfirm'), danger: true });
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
    if (!prev || !draft) return;
    // 跟着新默认值走；删掉的模型、不能再用的尺寸换回默认（规则见 draft.mjs）
    const { draft: d, droppedSize } = draftAfterSettingsSaved(draft, prev, next);
    if (droppedSize !== null) toast.info(t('app.sizeReset', { size: droppedSize, fallback: next.defaultSize || t('size.none') }));
    setDraft(d);
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
      toast.error(t('app.needConfig'));
      setView('settings');
      return;
    }
    const prompts = draft.perLine ? text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [text];
    const { mask, inputs } = splitAttachments(draft);
    if (mask && !inputs.length) {
      toast.error(t('app.maskNeedsInput'));
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
      fromHistory: sizeFromHistory(draft),
    };
    const sent = draft;
    submitting.current = true;
    try {
      let sid = activeId;
      if (!sid) {
        const s = await api.history.create(titleFrom(prompts[0], t));
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
          fromHistory: sizeFromHistory(draft),
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
        fromHistory: true, // 旧版本记录下的尺寸即使不符合现在的规则，也原样重发
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
      historySize: run.size,
      quality: run.quality,
      count: run.count,
      outName: run.outName || '',
      perLine: false,
    }));
  };

  const deleteRun = async (run) => {
    const ok = await ask({
      title: t('app.deleteRunTitle'),
      message: t('app.deleteRunMessage'),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (ok) api.history.removeRun(run.sessionId, run.id).catch((e) => toast.error(e.message));
  };

  const deleteSession = async (s) => {
    const ok = await ask({
      title: t('app.deleteSessionTitle'),
      message: t('app.deleteSessionMessage', { title: s.title, count: s.runs.length }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (ok) api.history.remove(s.id).catch((e) => toast.error(e.message));
  };

  const useAsRef = async (p) => {
    try {
      const a = await api.files.importImagePath(p);
      setDraft((d) => (d.attachments.some((x) => x.path === a.path) ? d : { ...d, attachments: [...d.attachments, a] }));
      if (view !== 'work') setView('work');
      toast.info(t('app.addedAsRef'));
    } catch (e) {
      toast.error(e.message);
    }
  };

  const openOutput = () => api.files.openDir().catch((e) => toast.error(e.message));

  if (!settings || !draft) return <div className="boot" />;

  return (
    <I18nProvider t={t}>
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
          // 只切换语言：只更新语言，不重算输入框草稿（保存回调可能比用户回到工作区继续输入还晚到）
          onLanguageSaved={(language) => setSettings((s) => ({ ...s, language }))}
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
    </I18nProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
