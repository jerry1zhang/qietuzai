import React, { useCallback, useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, ImagePlus, Copy, FolderOpen, Download, ExternalLink } from 'lucide-react';
import { api, basename, fileUrl } from '../lib.js';
import { IconButton, useToast } from './ui.jsx';

export default function Lightbox({ paths, index, onClose, onUseAsRef }) {
  const toast = useToast();
  const [i, setI] = useState(index);
  const [dims, setDims] = useState(null);
  const p = paths[i];

  const prev = useCallback(() => setI((v) => (v - 1 + paths.length) % paths.length), [paths.length]);
  const next = useCallback(() => setI((v) => (v + 1) % paths.length), [paths.length]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, prev, next]);

  useEffect(() => setDims(null), [p]);

  if (!p) return null;

  const act = (fn, ok) => async () => {
    try {
      const r = await fn();
      if (ok && r !== null) toast.success(ok);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="lightbox" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-top">
        <span className="lightbox-name" title={p}>
          {basename(p)}
          {dims && <span className="muted"> · {dims}</span>}
        </span>
        <span className="muted">{paths.length > 1 ? `${i + 1} / ${paths.length}` : ''}</span>
        <IconButton title="关闭 (Esc)" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {paths.length > 1 && (
          <IconButton className="lightbox-nav lightbox-prev" title="上一张 (←)" onClick={prev}>
            <ChevronLeft size={22} />
          </IconButton>
        )}
        <img
          src={fileUrl(p)}
          alt=""
          draggable
          onDragStart={(e) => {
            e.preventDefault();
            api.files.startDrag(p);
          }}
          onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
        />
        {paths.length > 1 && (
          <IconButton className="lightbox-nav lightbox-next" title="下一张 (→)" onClick={next}>
            <ChevronRight size={22} />
          </IconButton>
        )}
      </div>

      <div className="lightbox-bar">
        {onUseAsRef && (
          <button
            type="button"
            className="act-btn"
            onClick={async () => {
              await onUseAsRef(p);
              onClose();
            }}
          >
            <ImagePlus size={14} /> 作为参考图
          </button>
        )}
        <button type="button" className="act-btn" onClick={act(() => api.files.copyImage(p), '已复制到剪贴板')}>
          <Copy size={14} /> 复制
        </button>
        <button type="button" className="act-btn" onClick={act(() => api.files.reveal(p))}>
          <FolderOpen size={14} /> 在文件夹中显示
        </button>
        <button type="button" className="act-btn" onClick={act(() => api.files.open(p))}>
          <ExternalLink size={14} /> 用系统应用打开
        </button>
        <button type="button" className="act-btn" onClick={act(() => api.files.saveAs(p), '已保存')}>
          <Download size={14} /> 另存为
        </button>
      </div>
    </div>
  );
}
