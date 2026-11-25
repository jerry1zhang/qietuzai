import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SquarePen, Search, Settings, FolderOpen, Pencil, Trash2, Loader2, X } from 'lucide-react';
import { cx, groupSessions, relativeTime, sessionRunning } from '../lib.js';
import { IconButton } from './ui.jsx';
import { useT } from '../i18n.jsx';

function SessionItem({ s, active, onSelect, onRename, onDelete, now }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const inputRef = useRef(null);
  const busy = sessionRunning(s);

  useEffect(() => {
    if (editing) {
      setTitle(s.title);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, s.title]);

  const commit = () => {
    setEditing(false);
    const next = title.trim();
    if (next && next !== s.title) onRename(s.id, next);
  };

  if (editing) {
    return (
      <div className="session-item is-editing">
        <input
          ref={inputRef}
          className="session-rename"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={cx('session-item', active && 'is-active')}
      onClick={() => onSelect(s.id)}
      onDoubleClick={() => setEditing(true)}
      title={s.title}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(s.id)}
    >
      <span className="session-title">{s.title}</span>
      <span className="session-meta">
        {busy ? <Loader2 size={13} className="spin" /> : <span className="session-time">{relativeTime(s.updatedAt, now, t)}</span>}
      </span>
      <span className="session-actions" onClick={(e) => e.stopPropagation()}>
        <IconButton title={t('common.rename')} size="xs" onClick={() => setEditing(true)}>
          <Pencil size={13} />
        </IconButton>
        <IconButton title={t('common.delete')} size="xs" onClick={() => onDelete(s)}>
          <Trash2 size={13} />
        </IconButton>
      </span>
    </div>
  );
}

export default function Sidebar({ sessions, activeId, view, onSelect, onNew, onRename, onDelete, onOpenSettings, onOpenOutput }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return sessions;
    return sessions.filter(
      (s) => s.title.toLowerCase().includes(k) || (s.runs || []).some((r) => r.prompt.toLowerCase().includes(k)),
    );
  }, [sessions, q]);
  const groups = useMemo(() => groupSessions(filtered), [filtered]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="brand">切图仔</span>
      </div>

      <div className="sidebar-actions">
        <button type="button" className={cx('nav-btn', view === 'work' && !activeId && 'is-active')} onClick={onNew}>
          <SquarePen size={16} />
          <span>{t('sidebar.newTask')}</span>
          <kbd>{window.api?.platform === 'darwin' ? '⌘N' : 'Ctrl+N'}</kbd>
        </button>
        <div className="search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sidebar.search')} />
          {q && (
            <IconButton title={t('common.clear')} size="xs" onClick={() => setQ('')}>
              <X size={12} />
            </IconButton>
          )}
        </div>
      </div>

      <div className="session-list">
        {groups.length === 0 && <div className="session-empty">{q ? t('sidebar.noMatch') : t('sidebar.empty')}</div>}
        {groups.map((g) => (
          <div key={g.key} className="session-group">
            <div className="session-group-label">{t(`group.${g.key}`)}</div>
            {g.items.map((s) => (
              <SessionItem
                key={s.id}
                s={s}
                now={now}
                active={view === 'work' && s.id === activeId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button type="button" className={cx('nav-btn', view === 'settings' && 'is-active')} onClick={onOpenSettings}>
          <Settings size={16} />
          <span>{t('common.settings')}</span>
        </button>
        <IconButton title={t('common.openOutputDir')} onClick={onOpenOutput}>
          <FolderOpen size={16} />
        </IconButton>
      </div>
    </aside>
  );
}
