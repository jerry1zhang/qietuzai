import React, { useEffect, useState } from 'react';
import {
  RotateCcw,
  PencilLine,
  Copy,
  Square,
  Trash2,
  ImagePlus,
  FolderOpen,
  Download,
  Loader2,
  AlertTriangle,
  Ban,
  Bot,
  ChevronDown,
  ChevronUp,
  FileCode2,
  Clock3,
  ImageOff,
  Ruler,
} from 'lucide-react';
import { api, aspectOf, basename, cx, fileUrl, formatClock, formatDuration, parseRatio, parseSize, qualityLabel, runStats, sizeLabel, sizeMatches } from '../lib.js';
import { IconButton, useToast } from './ui.jsx';
import { useT } from '../i18n.jsx';

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// 接口实际返回的尺寸：以生成时从文件头读出、存进历史的为准（EXIF 旋转已算进去），
// 这样之后在磁盘上替换了图片也不会误报；旧记录没存宽高时，才用图片加载后浏览器报告的
function itemDims(item, loaded) {
  if (item.width && item.height) return { width: item.width, height: item.height };
  return loaded || null;
}

// 像素要完全一致，比例按宽高比比较；请求是 auto 或认不出的写法时不判断
const isMismatch = (requestedSize, dims) => sizeMatches(requestedSize, dims) === false;

function Tile({ item, aspect, now, requestedSize, dims, onDims, onOpen, onUseAsRef }) {
  const toast = useToast();
  const t = useT();
  const [broken, setBroken] = useState(false);

  if (item.status === 'done' && item.path) {
    if (broken) {
      return (
        <div className="tile tile-state" style={{ aspectRatio: aspect }}>
          <ImageOff size={20} />
          <span>{t('run.fileMissing')}</span>
          <span className="tile-path">{basename(item.path)}</span>
        </div>
      );
    }
    const act = (fn, ok) => async (e) => {
      e.stopPropagation();
      try {
        const r = await fn();
        if (ok && r !== null) toast.success(ok);
      } catch (err) {
        toast.error(err.message);
      }
    };
    const mismatch = isMismatch(requestedSize, dims);
    return (
      <div
        className="tile tile-done"
        style={{ aspectRatio: dims ? `${dims.width} / ${dims.height}` : aspect }}
        onClick={onOpen}
        draggable
        onDragStart={(e) => {
          e.preventDefault();
          api.files.startDrag(item.path);
        }}
        title={t('run.dragTitle', { name: basename(item.path) })}
      >
        <img
          src={fileUrl(item.path)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
          onLoad={(e) => onDims(item.index, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
        />
        {dims && (
          <span
            className={cx('tile-dim', mismatch && 'is-warn')}
            title={
              mismatch
                ? t('run.sizeMismatch', { requested: requestedSize, actual: `${dims.width}x${dims.height}` })
                : t('run.actualSize', { size: `${dims.width}x${dims.height}` })
            }
          >
            {mismatch && <AlertTriangle size={11} />}
            {dims.width}×{dims.height}
          </span>
        )}
        <div className="tile-tools">
          <IconButton size="sm" title={t('action.useAsRef')} onClick={act(onUseAsRef)}>
            <ImagePlus size={14} />
          </IconButton>
          <IconButton size="sm" title={t('action.copyImage')} onClick={act(() => api.files.copyImage(item.path), t('common.copiedToClipboard'))}>
            <Copy size={14} />
          </IconButton>
          <IconButton size="sm" title={t('action.reveal')} onClick={act(() => api.files.reveal(item.path))}>
            <FolderOpen size={14} />
          </IconButton>
          <IconButton size="sm" title={t('action.saveAsEllipsis')} onClick={act(() => api.files.saveAs(item.path), t('common.saved'))}>
            <Download size={14} />
          </IconButton>
        </div>
      </div>
    );
  }

  if (item.status === 'error') {
    return (
      <div className="tile tile-state tile-error" style={{ aspectRatio: aspect }}>
        <AlertTriangle size={18} />
        <div className="tile-error-msg" title={item.error}>
          {item.error}
        </div>
        <button
          type="button"
          className="link-btn"
          onClick={async () => {
            await api.files.copyText(item.error);
            toast.success(t('run.copiedError'));
          }}
        >
          {t('run.copyError')}
        </button>
      </div>
    );
  }

  if (item.status === 'canceled') {
    return (
      <div className="tile tile-state" style={{ aspectRatio: aspect }}>
        <Ban size={18} />
        <span>{t('run.canceled')}</span>
      </div>
    );
  }

  const running = item.status === 'running';
  return (
    <div className="tile tile-state tile-pending" style={{ aspectRatio: aspect }}>
      <div className="shimmer" />
      {running ? <Loader2 size={20} className="spin" /> : <Clock3 size={18} />}
      <span>{running ? t('run.generating', { time: formatDuration(Math.max(0, now - (item.startedAt || now))) }) : t('run.queued')}</span>
    </div>
  );
}

const STATUS = {
  running: ['is-running', 'run.statusRunning'],
  done: ['is-done', 'run.statusDone'],
  partial: ['is-partial', 'run.statusPartial'],
  canceled: ['is-muted', 'run.statusCanceled'],
  interrupted: ['is-error', 'run.statusInterrupted'],
  error: ['is-error', 'run.statusFailed'],
};

function statusText(run, stats, now, t) {
  const elapsed = formatDuration((run.finishedAt || now) - run.createdAt);
  // 认不出的状态（包括 constructor 这类对象原型上的名字）都按失败显示
  const [cls, key] = Object.hasOwn(STATUS, run.status) ? STATUS[run.status] : STATUS.error;
  return { cls, text: t(key, { done: stats.done, total: stats.total, elapsed }) };
}

function mismatchNote(run, requested, list, t) {
  const sameOrientation = list.every((d) => Math.sign(d.width - d.height) === Math.sign(requested.width - requested.height));
  const actual = [...new Set(list.map((d) => `${d.width}x${d.height}`))].join(t('common.listSep'));
  const head = t('run.mismatchHead', { requested: run.size, actual });
  const tail = t(run.sizeHint ? 'run.mismatchHinted' : 'run.mismatchSuggest');
  return { label: t(sameOrientation ? 'run.sizeOff' : 'run.sizeIgnored'), text: head + tail };
}

export default function RunCard({ run, onRerun, onEdit, onDelete, onOpenImage, onUseAsRef, onPreviewRequest, onOpenSettings }) {
  const toast = useToast();
  const t = useT();
  const isRunning = run.status === 'running';
  const now = useNow(isRunning);
  const stats = runStats(run);
  const st = statusText(run, stats, now, t);
  const [expanded, setExpanded] = useState(false);
  const long = run.prompt.length > 220 || run.prompt.split('\n').length > 5;
  const aspect = aspectOf(run.size);
  const doneItems = run.items.filter((i) => i.status === 'done' && i.path);
  const cols = Math.min(run.count, 4);
  // 请求的方向（像素或比例），用来区分「尺寸有偏差」和「尺寸未生效」
  const requested = parseSize(run.size) || parseRatio(run.size);
  const [loadedDims, setLoadedDims] = useState({});
  const onDims = (index, width, height) =>
    setLoadedDims((m) => (m[index]?.width === width && m[index]?.height === height ? m : { ...m, [index]: { width, height } }));
  const mismatched = doneItems.map((it) => itemDims(it, loadedDims[it.index])).filter((d) => isMismatch(run.size, d));
  const note = mismatched.length ? mismatchNote(run, requested, mismatched, t) : null;
  const refs = [...run.inputs, ...(run.mask ? [{ ...run.mask, isMask: true }] : [])];

  return (
    <article className="run">
      <div className="run-user">
        {refs.length > 0 && (
          <div className="run-refs">
            {refs.map((f, i) => (
              <button
                type="button"
                key={f.path + i}
                className={cx('run-ref', f.isMask && 'is-mask')}
                onClick={() => onOpenImage(refs.map((x) => x.path), i)}
                title={f.isMask ? t('run.maskTitle', { name: f.name }) : f.name}
              >
                <img src={fileUrl(f.path)} alt="" loading="lazy" />
                {f.isMask && <span>{t('composer.mask')}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="bubble">
          <div className={cx('bubble-text', long && !expanded && 'is-clamped')}>{run.prompt}</div>
          {long && (
            <button type="button" className="link-btn bubble-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? (
                <>
                  {t('run.collapse')} <ChevronUp size={12} />
                </>
              ) : (
                <>
                  {t('run.expand')} <ChevronDown size={12} />
                </>
              )}
            </button>
          )}
        </div>
        <div className="run-time">{formatClock(run.createdAt, t.locale)}</div>
      </div>

      <div className="run-result">
        <div className="run-meta">
          <span className={cx('status', st.cls)}>
            {isRunning && <Loader2 size={13} className="spin" />}
            {st.text}
          </span>
          <span className="meta-sep" />
          <span className="chip">{t(run.mode === 'edit' ? 'mode.edit' : 'mode.generate')}</span>
          <span className="chip">{run.model}</span>
          <span className="chip">{sizeLabel(run.size, t)}</span>
          {run.quality && <span className="chip">{qualityLabel(run.quality, t)}</span>}
          <span className="chip">× {run.count}</span>
          {run.sizeHint && (
            <span className="chip" title={t('run.sizeHintTitle', { hint: run.sizeHint })}>
              <Ruler size={11} /> {t('composer.sizeInPrompt')}
            </span>
          )}
          {note && (
            <button type="button" className="chip chip-btn chip-warn" title={note.text} onClick={onOpenSettings}>
              <AlertTriangle size={11} /> {note.label}
            </button>
          )}
          {run.agentsApplied && (
            <span className="chip" title={run.finalPrompt}>
              <Bot size={11} /> Agents
            </span>
          )}
        </div>

        <div className={cx('grid', `grid-${cols}`)}>
          {run.items.map((it) => (
            <Tile
              key={it.index}
              item={it}
              aspect={aspect}
              now={now}
              requestedSize={run.size}
              dims={itemDims(it, loadedDims[it.index])}
              onDims={onDims}
              onOpen={() =>
                onOpenImage(
                  doneItems.map((d) => d.path),
                  doneItems.findIndex((d) => d.index === it.index),
                )
              }
              onUseAsRef={() => onUseAsRef(it.path)}
            />
          ))}
        </div>

        <div className="run-actions">
          {isRunning ? (
            <button type="button" className="act-btn" onClick={() => api.gen.cancel(run.id)}>
              <Square size={13} /> {t('run.stop')}
            </button>
          ) : (
            <button type="button" className="act-btn" onClick={onRerun} title={t('run.rerunTitle')}>
              <RotateCcw size={13} /> {t('run.rerun')}
            </button>
          )}
          <button type="button" className="act-btn" onClick={onEdit} title={t('run.editTitle')}>
            <PencilLine size={13} /> {t('run.edit')}
          </button>
          <button
            type="button"
            className="act-btn"
            onClick={async () => {
              await api.files.copyText(run.prompt);
              toast.success(t('run.copiedPrompt'));
            }}
          >
            <Copy size={13} /> {t('run.copyPrompt')}
          </button>
          <button type="button" className="act-btn" onClick={onPreviewRequest} title={t('run.detailsTitle')}>
            <FileCode2 size={13} /> {t('run.details')}
          </button>
          {doneItems.length > 0 && (
            <button type="button" className="act-btn" onClick={() => api.files.reveal(doneItems[0].path)}>
              <FolderOpen size={13} /> {t('run.openDir')}
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className="act-btn act-danger" onClick={onDelete} title={t('run.deleteTitle')}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}
