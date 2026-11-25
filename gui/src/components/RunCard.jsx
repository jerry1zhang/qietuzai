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
  const [broken, setBroken] = useState(false);

  if (item.status === 'done' && item.path) {
    if (broken) {
      return (
        <div className="tile tile-state" style={{ aspectRatio: aspect }}>
          <ImageOff size={20} />
          <span>文件已被移动或删除</span>
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
        title={`${basename(item.path)}（可直接拖到其他软件）`}
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
                ? `请求的是 ${requestedSize}，接口实际返回 ${dims.width}x${dims.height}`
                : `实际尺寸 ${dims.width}x${dims.height}`
            }
          >
            {mismatch && <AlertTriangle size={11} />}
            {dims.width}×{dims.height}
          </span>
        )}
        <div className="tile-tools">
          <IconButton size="sm" title="作为参考图" onClick={act(onUseAsRef)}>
            <ImagePlus size={14} />
          </IconButton>
          <IconButton size="sm" title="复制图片" onClick={act(() => api.files.copyImage(item.path), '已复制到剪贴板')}>
            <Copy size={14} />
          </IconButton>
          <IconButton size="sm" title="在文件夹中显示" onClick={act(() => api.files.reveal(item.path))}>
            <FolderOpen size={14} />
          </IconButton>
          <IconButton size="sm" title="另存为…" onClick={act(() => api.files.saveAs(item.path), '已保存')}>
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
            toast.success('已复制错误信息');
          }}
        >
          复制错误
        </button>
      </div>
    );
  }

  if (item.status === 'canceled') {
    return (
      <div className="tile tile-state" style={{ aspectRatio: aspect }}>
        <Ban size={18} />
        <span>已取消</span>
      </div>
    );
  }

  const running = item.status === 'running';
  return (
    <div className="tile tile-state tile-pending" style={{ aspectRatio: aspect }}>
      <div className="shimmer" />
      {running ? <Loader2 size={20} className="spin" /> : <Clock3 size={18} />}
      <span>{running ? `生成中 ${formatDuration(Math.max(0, now - (item.startedAt || now)))}` : '排队中'}</span>
    </div>
  );
}

function statusText(run, stats, now) {
  const elapsed = formatDuration((run.finishedAt || now) - run.createdAt);
  switch (run.status) {
    case 'running':
      return { cls: 'is-running', text: `生成中 ${stats.done}/${stats.total} · ${elapsed}` };
    case 'done':
      return { cls: 'is-done', text: `完成 ${stats.done}/${stats.total} · ${elapsed}` };
    case 'partial':
      return { cls: 'is-partial', text: `部分完成 ${stats.done}/${stats.total} · ${elapsed}` };
    case 'canceled':
      return { cls: 'is-muted', text: `已取消 · ${stats.done}/${stats.total}` };
    case 'interrupted':
      return { cls: 'is-error', text: `已中断 · ${stats.done}/${stats.total}` };
    default:
      return { cls: 'is-error', text: `失败 0/${stats.total} · ${elapsed}` };
  }
}

function mismatchNote(run, requested, list) {
  const sameOrientation = list.every((d) => Math.sign(d.width - d.height) === Math.sign(requested.width - requested.height));
  const actual = [...new Set(list.map((d) => `${d.width}x${d.height}`))].join('、');
  const head = `请求的是 ${run.size}，接口实际返回 ${actual}。`;
  const tail = run.sizeHint
    ? '这次已经把尺寸写进了提示词，模型也只是大致照做。这个接口似乎不支持精确控制尺寸，需要的话请在本地裁剪或缩放。'
    : '这个接口可能忽略了 size 参数。可以在设置里打开「把尺寸写进提示词」试试（点击前往设置）。';
  return { label: sameOrientation ? '尺寸有偏差' : '尺寸未生效', text: head + tail };
}

export default function RunCard({ run, onRerun, onEdit, onDelete, onOpenImage, onUseAsRef, onPreviewRequest, onOpenSettings }) {
  const toast = useToast();
  const isRunning = run.status === 'running';
  const now = useNow(isRunning);
  const stats = runStats(run);
  const st = statusText(run, stats, now);
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
  const note = mismatched.length ? mismatchNote(run, requested, mismatched) : null;
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
                title={f.isMask ? `蒙版：${f.name}` : f.name}
              >
                <img src={fileUrl(f.path)} alt="" loading="lazy" />
                {f.isMask && <span>蒙版</span>}
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
                  收起 <ChevronUp size={12} />
                </>
              ) : (
                <>
                  展开 <ChevronDown size={12} />
                </>
              )}
            </button>
          )}
        </div>
        <div className="run-time">{formatClock(run.createdAt)}</div>
      </div>

      <div className="run-result">
        <div className="run-meta">
          <span className={cx('status', st.cls)}>
            {isRunning && <Loader2 size={13} className="spin" />}
            {st.text}
          </span>
          <span className="meta-sep" />
          <span className="chip">{run.mode === 'edit' ? '图生图' : '文生图'}</span>
          <span className="chip">{run.model}</span>
          <span className="chip">{sizeLabel(run.size)}</span>
          {run.quality && <span className="chip">{qualityLabel(run.quality)}</span>}
          <span className="chip">× {run.count}</span>
          {run.sizeHint && (
            <span className="chip" title={`提示词末尾加了：${run.sizeHint}`}>
              <Ruler size={11} /> 尺寸写入提示词
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
              <Square size={13} /> 停止
            </button>
          ) : (
            <button type="button" className="act-btn" onClick={onRerun} title="用同样的参数再生成一组">
              <RotateCcw size={13} /> 重新生成
            </button>
          )}
          <button type="button" className="act-btn" onClick={onEdit} title="把提示词、参考图和参数填回输入框">
            <PencilLine size={13} /> 编辑后重试
          </button>
          <button
            type="button"
            className="act-btn"
            onClick={async () => {
              await api.files.copyText(run.prompt);
              toast.success('已复制提示词');
            }}
          >
            <Copy size={13} /> 复制提示词
          </button>
          <button type="button" className="act-btn" onClick={onPreviewRequest} title="查看这次实际发送的请求">
            <FileCode2 size={13} /> 请求详情
          </button>
          {doneItems.length > 0 && (
            <button type="button" className="act-btn" onClick={() => api.files.reveal(doneItems[0].path)}>
              <FolderOpen size={13} /> 打开目录
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className="act-btn act-danger" onClick={onDelete} title="删除这条记录（不会删除图片文件）">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}
