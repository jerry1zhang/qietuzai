import React, { useCallback, useEffect, useRef, useState, createContext, useContext } from 'react';
import { Check, ChevronDown, X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { cx } from '../lib.js';

export function useOutsideClose(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return ref;
}

export function IconButton({ title, onClick, children, className, disabled, active, size = 'md', ...rest }) {
  return (
    <button
      type="button"
      className={cx('icon-btn', `icon-btn-${size}`, active && 'is-active', className)}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * 下拉选择（向上或向下弹出）
 * options: [{ value, label, hint }]
 */
export function Dropdown({
  value,
  options,
  onChange,
  icon,
  label,
  title,
  placement = 'top',
  align = 'left',
  allowCustom = false,
  customPlaceholder = '自定义…',
  parseCustom, // 可选：校验并规范化自定义值，返回 null 表示不合法
  customError = '格式不对',
  className,
  footer,
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [customErr, setCustomErr] = useState('');
  const close = useCallback(() => {
    setOpen(false);
    setCustomErr('');
  }, []);
  const ref = useOutsideClose(open, close);
  const current = options.find((o) => o.value === value);

  const pick = (v) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className={cx('dropdown', className)} ref={ref}>
      <button
        type="button"
        className={cx('pill', open && 'is-open')}
        title={title}
        onClick={() => {
          setOpen((o) => !o);
          setCustomErr('');
        }}
      >
        {icon}
        <span className="pill-label">{label ?? current?.label ?? value}</span>
        <ChevronDown size={13} className="pill-caret" />
      </button>
      {open && (
        <div className={cx('menu', `menu-${placement}`, `menu-align-${align}`)}>
          {title && <div className="menu-title">{title}</div>}
          <div className="menu-scroll">
            {options.map((o) => (
              <button type="button" key={o.value} className={cx('menu-item', o.value === value && 'is-selected')} onClick={() => pick(o.value)}>
                <span className="menu-item-main">
                  <span>{o.label}</span>
                  {o.hint && <span className="menu-item-hint">{o.hint}</span>}
                </span>
                {o.value === value && <Check size={14} />}
              </button>
            ))}
          </div>
          {allowCustom && (
            <form
              className="menu-custom"
              onSubmit={(e) => {
                e.preventDefault();
                const raw = custom.trim();
                if (!raw) return;
                const v = parseCustom ? parseCustom(raw) : raw;
                if (v === null || v === undefined || v === '') {
                  setCustomErr(customError);
                  return;
                }
                pick(v);
                setCustom('');
                setCustomErr('');
              }}
            >
              <input
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setCustomErr('');
                }}
                placeholder={customPlaceholder}
                aria-invalid={Boolean(customErr)}
              />
              {customErr && <div className="menu-custom-error">{customErr}</div>}
            </form>
          )}
          {footer && <div className="menu-footer">{footer(close)}</div>}
        </div>
      )}
    </div>
  );
}

export function Popover({ trigger, children, placement = 'top', align = 'left', className }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutsideClose(open, close);
  return (
    <div className={cx('dropdown', className)} ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && <div className={cx('menu', 'menu-pad', `menu-${placement}`, `menu-align-${align}`)}>{children(close)}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className={cx('switch', disabled && 'is-disabled')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      {label && <span className="switch-label">{label}</span>}
    </label>
  );
}

export function Modal({ title, children, footer, onClose, width = 520, className }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={cx('modal', className)} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <IconButton title="关闭" size="sm" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmText = '确定', danger, onConfirm, onCancel }) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className={cx('btn', danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm} autoFocus>
            {confirmText}
          </button>
        </>
      }
    >
      <p className="confirm-msg">{message}</p>
    </Modal>
  );
}

// ---------------- Toast ----------------
const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((type, text) => {
    const id = Math.random().toString(36).slice(2);
    setItems((l) => [...l, { id, type, text }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), type === 'error' ? 5000 : 2400);
  }, []);
  const api = React.useMemo(
    () => ({
      info: (t) => push('info', t),
      success: (t) => push('success', t),
      error: (t) => push('error', t),
    }),
    [push],
  );
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.type}`)}>
            {t.type === 'success' ? <CheckCircle2 size={16} /> : t.type === 'error' ? <AlertCircle size={16} /> : <Info size={16} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
