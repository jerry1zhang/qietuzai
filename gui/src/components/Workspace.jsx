import React, { useEffect, useRef } from 'react';
import { FolderOpen, Settings, AlertCircle } from 'lucide-react';
import RunCard from './RunCard.jsx';
import Composer from './Composer.jsx';
import { IconButton } from './ui.jsx';
import { runStats } from '../lib.js';

const EXAMPLES = [
  '一只戴着宇航员头盔的柴犬，坐在月球表面，电影感光影，35mm',
  '极简风格的咖啡店 Logo，线条插画，米白色背景',
  '赛博朋克城市夜景，霓虹灯，雨后街道反光，广角',
  '电商主图：白色运动鞋悬浮在柔和渐变背景上，产品摄影',
];

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
      <span>还没有配置接口地址和 API Key</span>
      <button type="button" className="link-btn" onClick={onOpenSettings}>
        去设置
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
            <h1>想生成什么图？</h1>
            <p className="hero-sub">输入提示词直接生成；拖入或粘贴图片即为图生图。</p>
            {banner}
            {composer('hero')}
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button type="button" key={ex} className="example" onClick={() => setDraft((d) => ({ ...d, prompt: ex }))}>
                  {ex}
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
            {session.runs.length} 次生成 · {totals.done} 张图
          </span>
          <IconButton title="打开输出目录" onClick={onOpenOutput}>
            <FolderOpen size={16} />
          </IconButton>
          <IconButton title="设置" onClick={onOpenSettings}>
            <Settings size={16} />
          </IconButton>
        </div>
      </header>

      <div className="thread" ref={scrollRef}>
        <div className="thread-inner">
          {session.runs.length === 0 && <div className="thread-empty">这里还没有生成记录</div>}
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
          <div className="composer-hint">Enter 生成 · Shift+Enter 换行 · 支持拖入 / 粘贴图片</div>
        </div>
      </div>
    </main>
  );
}
