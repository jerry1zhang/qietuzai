import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ImagePlus,
  Box,
  Ratio,
  Sparkles,
  Minus,
  Plus,
  SlidersHorizontal,
  FileCode2,
  X,
  Layers,
  Bot,
  Ruler,
} from 'lucide-react';
import { api, cx, fileUrl, importFiles, MAX_COUNT, normalizeSize, parseRatio, parseSize, qualityLabel, sizeLabel } from '../lib.js';
import { useT } from '../i18n.jsx';
import { Dropdown, IconButton, Popover, Switch, useToast } from './ui.jsx';

function Stepper({ value, onChange }) {
  const t = useT();
  const set = (v) => onChange(Math.min(MAX_COUNT, Math.max(1, Number.parseInt(v, 10) || 1)));
  return (
    <div className="stepper" title={t('composer.countTitle')}>
      <button type="button" onClick={() => set(value - 1)} disabled={value <= 1} aria-label={t('composer.decrease')}>
        <Minus size={13} />
      </button>
      <input value={value} onChange={(e) => set(e.target.value)} inputMode="numeric" aria-label={t('composer.count')} />
      <span className="stepper-unit">{t('composer.unit', { count: value })}</span>
      <button type="button" onClick={() => set(value + 1)} disabled={value >= MAX_COUNT} aria-label={t('composer.increase')}>
        <Plus size={13} />
      </button>
    </div>
  );
}

function Attachment({ a, isMask, canMask, onRemove, onToggleMask, onPreview }) {
  const t = useT();
  return (
    <div className={cx('attach', isMask && 'is-mask')}>
      <img src={fileUrl(a.path)} alt={a.name} onClick={onPreview} draggable={false} />
      <button type="button" className="attach-remove" title={t('common.remove')} onClick={onRemove}>
        <X size={11} />
      </button>
      {(canMask || isMask) && (
        <button
          type="button"
          className={cx('attach-mask', isMask && 'is-on')}
          title={isMask ? t('composer.unsetMask') : t('composer.setMask')}
          onClick={onToggleMask}
        >
          {t('composer.mask')}
        </button>
      )}
    </div>
  );
}

export default function Composer({ draft, setDraft, settings, onSubmit, onPreviewRequest, onPreviewImage, onOpenSettings, autoFocus, variant }) {
  const toast = useToast();
  const t = useT();
  const taRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const isEdit = draft.attachments.some((a) => a.path !== draft.maskPath);
  const agentsOn = settings.agentsEnabled && settings.agentsPrompt.trim();
  const sizeInPromptOn = settings.sizeInPrompt && (parseSize(draft.size) || parseRatio(draft.size));
  const lineCount = draft.perLine ? draft.prompt.split(/\r?\n/).filter((s) => s.trim()).length : 1;
  const canSubmit = draft.prompt.trim().length > 0;

  const update = (patch) => setDraft((d) => ({ ...d, ...patch }));

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
  }, [draft.prompt]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  const addAttachments = (list) => {
    if (!list.length) return;
    setDraft((d) => {
      const exist = new Set(d.attachments.map((a) => a.path));
      return { ...d, attachments: [...d.attachments, ...list.filter((a) => !exist.has(a.path))] };
    });
  };

  const pickImages = async () => {
    try {
      addAttachments(await api.files.pickImages());
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onFiles = async (files) => {
    try {
      const list = await importFiles(files);
      if (!list.length) toast.error(t('composer.unsupportedImage'));
      addAttachments(list);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      onFiles(files);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (canSubmit) onSubmit();
    }
  };

  const removeAttachment = (p) =>
    setDraft((d) => ({ ...d, attachments: d.attachments.filter((a) => a.path !== p), maskPath: d.maskPath === p ? null : d.maskPath }));

  const toggleMask = (p) => setDraft((d) => ({ ...d, maskPath: d.maskPath === p ? null : p }));

  const modelOptions = settings.models.map((m) => ({ value: m, label: m, hint: m === settings.defaultModel ? t('common.default') : undefined }));
  const sizeOptions = [...new Set([...(settings.sizes || []), draft.size].filter(Boolean))].map((s) => ({
    value: s,
    label: sizeLabel(s, t),
    hint: s === settings.defaultSize ? t('common.default') : undefined,
  }));
  const qualityOptions = [...new Set(['', ...(settings.qualities || []), draft.quality])].map((q) => ({
    value: q,
    label: q ? `${qualityLabel(q, t)}${qualityLabel(q, t) !== q ? ` (${q})` : ''}` : t('quality.unset'),
  }));

  const placeholder = t(
    isEdit
      ? draft.perLine
        ? 'composer.placeholderEditPerLine'
        : 'composer.placeholderEdit'
      : draft.perLine
        ? 'composer.placeholderPerLine'
        : 'composer.placeholder',
  );

  return (
    <div
      className={cx('composer', variant === 'hero' && 'composer-hero', dragOver && 'is-dragover')}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragOver(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        onFiles(e.dataTransfer.files);
      }}
    >
      {dragOver && <div className="drop-hint">{t('composer.dropHint')}</div>}

      {draft.attachments.length > 0 && (
        <div className="attach-row">
          {draft.attachments.map((a, i) => (
            <Attachment
              key={a.path}
              a={a}
              isMask={draft.maskPath === a.path}
              canMask={draft.attachments.length >= 2}
              onRemove={() => removeAttachment(a.path)}
              onToggleMask={() => toggleMask(a.path)}
              onPreview={() => onPreviewImage(draft.attachments.map((x) => x.path), i)}
            />
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        className="composer-input"
        rows={variant === 'hero' ? 3 : 2}
        value={draft.prompt}
        placeholder={placeholder}
        onChange={(e) => update({ prompt: e.target.value })}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        spellCheck={false}
      />

      <div className="composer-bar">
        <div className="composer-tools">
          <IconButton title={t('composer.addRef')} onClick={pickImages}>
            <ImagePlus size={17} />
          </IconButton>
          <Dropdown
            title={t('composer.model')}
            icon={<Box size={14} />}
            value={draft.model}
            options={modelOptions}
            onChange={(v) => update({ model: v })}
            allowCustom
            customPlaceholder={t('composer.modelCustom')}
          />
          <Dropdown
            title={t('composer.size')}
            icon={<Ratio size={14} />}
            value={draft.size}
            label={sizeLabel(draft.size, t)}
            options={sizeOptions}
            onChange={(v) => update({ size: v })}
            allowCustom
            customPlaceholder={t('composer.sizeCustom')}
            parseCustom={normalizeSize}
            customError={t('composer.sizeCustomError', { hint: t('size.formatHint') })}
          />
          <Dropdown
            title={t('composer.quality')}
            icon={<Sparkles size={14} />}
            value={draft.quality}
            label={qualityLabel(draft.quality, t)}
            options={qualityOptions}
            onChange={(v) => update({ quality: v })}
          />
          <Stepper value={draft.count} onChange={(v) => update({ count: v })} />
          <Popover
            trigger={({ open, toggle }) => (
              <IconButton title={t('composer.more')} onClick={toggle} active={open || draft.perLine || !!draft.outName}>
                <SlidersHorizontal size={16} />
              </IconButton>
            )}
          >
            {() => (
              <div className="more-panel">
                <label className="field">
                  <span className="field-label">{t('composer.outName')}</span>
                  <input
                    value={draft.outName}
                    onChange={(e) => update({ outName: e.target.value })}
                    placeholder={t('composer.outNamePlaceholder')}
                  />
                  <span className="field-hint">{t('composer.outNameHint')}</span>
                </label>
                <div className="field">
                  <Switch checked={draft.perLine} onChange={(v) => update({ perLine: v })} label={t('composer.perLine')} />
                  <span className="field-hint">{t('composer.perLineHint', { count: draft.count })}</span>
                </div>
              </div>
            )}
          </Popover>
        </div>

        <div className="composer-right">
          {draft.perLine && lineCount > 1 && (
            <span className="chip chip-accent" title={t('composer.batchTitle')}>
              <Layers size={12} /> {t('composer.batchChip', { count: lineCount, per: draft.count })}
            </span>
          )}
          <span className={cx('chip', isEdit && 'chip-accent')}>{t(isEdit ? 'mode.edit' : 'mode.generate')}</span>
          {sizeInPromptOn && (
            <button
              type="button"
              className="chip chip-btn"
              title={t('composer.sizeInPromptTitle', { size: draft.size })}
              onClick={onOpenSettings}
            >
              <Ruler size={12} /> {t('composer.sizeInPrompt')}
            </button>
          )}
          {agentsOn && (
            <button type="button" className="chip chip-btn" title={t('composer.agentsTitle')} onClick={onOpenSettings}>
              <Bot size={12} /> Agents
            </button>
          )}
          <IconButton title={t('composer.preview')} onClick={onPreviewRequest}>
            <FileCode2 size={16} />
          </IconButton>
          <button type="button" className="send-btn" title={t('composer.send')} disabled={!canSubmit} onClick={onSubmit}>
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
