import React, { useCallback, useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, ImagePlus, Copy, FolderOpen, Download, ExternalLink } from 'lucide-react';
import { api, basename, fileUrl } from '../lib.js';
import { IconButton, useToast } from './ui.jsx';
import { useT } from '../i18n.jsx';

export default function Lightbox({ paths, index, onClose, onUseAsRef }) {
  const toast = useToast();
  const t = useT();
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
        <IconButton title={t('lightbox.close')} onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {paths.length > 1 && (
          <IconButton className="lightbox-nav lightbox-prev" title={t('lightbox.prev')} onClick={prev}>
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
          <IconButton className="lightbox-nav lightbox-next" title={t('lightbox.next')} onClick={next}>
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
            <ImagePlus size={14} /> {t('action.useAsRef')}
          </button>
        )}
        <button type="button" className="act-btn" onClick={act(() => api.files.copyImage(p), t('common.copiedToClipboard'))}>
          <Copy size={14} /> {t('common.copy')}
        </button>
        <button type="button" className="act-btn" onClick={act(() => api.files.reveal(p))}>
          <FolderOpen size={14} /> {t('action.reveal')}
        </button>
        <button type="button" className="act-btn" onClick={act(() => api.files.open(p))}>
          <ExternalLink size={14} /> {t('action.openWithApp')}
        </button>
        <button type="button" className="act-btn" onClick={act(() => api.files.saveAs(p), t('common.saved'))}>
          <Download size={14} /> {t('action.saveAs')}
        </button>
      </div>
    </div>
  );
}
