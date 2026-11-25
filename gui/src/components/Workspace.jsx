import React, { useEffect, useRef } from 'react';
import { FolderOpen, Settings, AlertCircle } from 'lucide-react';
import RunCard from './RunCard.jsx';
import Composer from './Composer.jsx';
import { IconButton } from './ui.jsx';
import { runStats } from '../lib.js';
import { useT } from '../i18n.jsx';

const EXAMPLES = ['workspace.example1', 'workspace.example2', 'workspace.example3', 'workspace.example4'];

export default function Workspace({
  session,
  settings,
  draft,
  setDraft,
  onSubmit,
  onPreviewRequest,
  onRunPreview,
  onOpenImage,
  onUseAsRef,
  onRerun,
  onEditRun,
  onDeleteRun,
  onOpenSettings,
  onOpenOutput,
}) {
  const t = useT();
  const scrollRef = useRef(null);
  const runCount = session?.runs.length || 0;
  const configured = settings.apiUrl && settings.apiKey;

  // 切换会话或新增任务时滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.id, runCount]);

  const banner = !configured && (
    <div className="banner">
      <AlertCircle size={15} />
      <span>{t('workspace.notConfigured')}</span>
      <button type="button" className="link-btn" onClick={onOpenSettings}>
        {t('workspace.goSettings')}
      </button>
    </div>
  );

  const composer = (variant) => (
    <Composer
      variant={variant}
      draft={draft}
      setDraft={setDraft}
      settings={settings}
      onSubmit={onSubmit}
      onPreviewRequest={onPreviewRequest}
      onPreviewImage={onOpenImage}
      onOpenSettings={onOpenSettings}
      autoFocus
    />
  );

  if (!session) {
    return (
      <main className="main">
        <header className="main-header drag" />
        <div className="hero">
          <div className="hero-inner">
            <h1>{t('workspace.heroTitle')}</h1>
            <p className="hero-sub">{t('workspace.heroSub')}</p>
            {banner}
            {composer('hero')}
            <div className="examples">
              {EXAMPLES.map((key) => (
                <button type="button" key={key} className="example" onClick={() => setDraft((d) => ({ ...d, prompt: t(key) }))}>
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </main>
    );
  }

  const totals = session.runs.reduce(
    (acc, r) => {
      const s = runStats(r);
      acc.done += s.done;
      return acc;
    },
    { done: 0 },
  );

  return (
    <main className="main">
      <header className="main-header drag">
        <div className="main-title" title={session.title}>
          {session.title}
        </div>
        <div className="main-header-right no-drag">
          <span className="muted small">
            {t('workspace.runCount', { count: session.runs.length })} · {t('workspace.imageCount', { count: totals.done })}
          </span>
          <IconButton title={t('common.openOutputDir')} onClick={onOpenOutput}>
            <FolderOpen size={16} />
          </IconButton>
          <IconButton title={t('common.settings')} onClick={onOpenSettings}>
            <Settings size={16} />
          </IconButton>
        </div>
      </header>

      <div className="thread" ref={scrollRef}>
        <div className="thread-inner">
          {session.runs.length === 0 && <div className="thread-empty">{t('workspace.empty')}</div>}
          {session.runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              onRerun={() => onRerun(run)}
              onEdit={() => onEditRun(run)}
              onDelete={() => onDeleteRun(run)}
              onOpenImage={onOpenImage}
              onUseAsRef={onUseAsRef}
              onPreviewRequest={() => onRunPreview(run)}
              onOpenSettings={onOpenSettings}
            />
          ))}
        </div>
      </div>

      <div className="composer-dock">
        <div className="composer-dock-inner">
          {banner}
          {composer('dock')}
          <div className="composer-hint">{t('workspace.composerHint')}</div>
        </div>
      </div>
    </main>
  );
}
