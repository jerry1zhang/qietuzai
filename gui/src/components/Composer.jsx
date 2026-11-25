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
} from 'lucide-react';
import { api, cx, fileUrl, importFiles, MAX_COUNT, qualityLabel, sizeLabel } from '../lib.js';
import { Dropdown, IconButton, Popover, Switch, useToast } from './ui.jsx';

function Stepper({ value, onChange }) {
  const set = (v) => onChange(Math.min(MAX_COUNT, Math.max(1, Number.parseInt(v, 10) || 1)));
  return (
    <div className="stepper" title="生成数量（同一提示词并发生成多张变体）">
      <button type="button" onClick={() => set(value - 1)} disabled={value <= 1} aria-label="减少">
        <Minus size={13} />
      </button>
      <input value={value} onChange={(e) => set(e.target.value)} inputMode="numeric" aria-label="数量" />
      <span className="stepper-unit">张</span>
      <button type="button" onClick={() => set(value + 1)} disabled={value >= MAX_COUNT} aria-label="增加">
        <Plus size={13} />
      </button>
    </div>
  );
}

function Attachment({ a, isMask, canMask, onRemove, onToggleMask, onPreview }) {
  return (
    <div className={cx('attach', isMask && 'is-mask')}>
      <img src={fileUrl(a.path)} alt={a.name} onClick={onPreview} draggable={false} />
      <button type="button" className="attach-remove" title="移除" onClick={onRemove}>
        <X size={11} />
      </button>
      {(canMask || isMask) && (
        <button
          type="button"
          className={cx('attach-mask', isMask && 'is-on')}
          title={isMask ? '取消蒙版' : '设为蒙版（PNG 透明区域为要修改的部分）'}
          onClick={onToggleMask}
        >
          蒙版
        </button>
      )}
    </div>
  );
}

export default function Composer({ draft, setDraft, settings, onSubmit, onPreviewRequest, onPreviewImage, onOpenSettings, autoFocus, variant }) {
  const toast = useToast();
  const taRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const isEdit = draft.attachments.some((a) => a.path !== draft.maskPath);
  const agentsOn = settings.agentsEnabled && settings.agentsPrompt.trim();
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
      if (!list.length) toast.error('只支持 png / jpg / webp / gif 图片');
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

  const modelOptions = settings.models.map((m) => ({ value: m, label: m, hint: m === settings.defaultModel ? '默认' : undefined }));
  const sizeOptions = [...new Set([...(settings.sizes || []), draft.size].filter(Boolean))].map((s) => ({
    value: s,
    label: sizeLabel(s),
    hint: s === settings.defaultSize ? '默认' : undefined,
  }));
  const qualityOptions = [...new Set(['', ...(settings.qualities || []), draft.quality])].map((q) => ({
    value: q,
    label: q ? `${qualityLabel(q)}${qualityLabel(q) !== q ? ` (${q})` : ''}` : '不指定（不发送 quality）',
  }));

  const placeholder = isEdit
    ? draft.perLine
      ? '描述你想对参考图做的修改，每行一个提示词…'
      : '描述你想对参考图做的修改，例如：把背景换成雪景'
    : draft.perLine
      ? '每行一个提示词，将分别生成…'
      : '描述你想生成的图片，可拖入或粘贴参考图切换到图生图…';

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
      {dragOver && <div className="drop-hint">松开以添加参考图</div>}

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
          <IconButton title="添加参考图（图生图）" onClick={pickImages}>
            <ImagePlus size={17} />
          </IconButton>
          <Dropdown
            title="模型"
            icon={<Box size={14} />}
            value={draft.model}
            options={modelOptions}
            onChange={(v) => update({ model: v })}
            allowCustom
            customPlaceholder="输入其他模型名，回车使用"
          />
          <Dropdown
            title="尺寸"
            icon={<Ratio size={14} />}
            value={draft.size}
            label={sizeLabel(draft.size)}
            options={sizeOptions}
            onChange={(v) => update({ size: v })}
            allowCustom
            customPlaceholder="自定义，如 1792x1024"
          />
          <Dropdown
            title="质量"
            icon={<Sparkles size={14} />}
            value={draft.quality}
            label={qualityLabel(draft.quality)}
            options={qualityOptions}
            onChange={(v) => update({ quality: v })}
          />
          <Stepper value={draft.count} onChange={(v) => update({ count: v })} />
          <Popover
            trigger={({ open, toggle }) => (
              <IconButton title="更多选项" onClick={toggle} active={open || draft.perLine || !!draft.outName}>
                <SlidersHorizontal size={16} />
              </IconButton>
            )}
          >
            {() => (
              <div className="more-panel">
                <label className="field">
                  <span className="field-label">输出文件名（可选）</span>
                  <input
                    value={draft.outName}
                    onChange={(e) => update({ outName: e.target.value })}
                    placeholder="例如 banner.png 或 子目录/set.png"
                  />
                  <span className="field-hint">相对于保存目录；多张时自动加 -1、-2… 后缀，留空则按时间命名</span>
                </label>
                <div className="field">
                  <Switch checked={draft.perLine} onChange={(v) => update({ perLine: v })} label="批量：每行一个提示词" />
                  <span className="field-hint">开启后每一行提示词单独生成一组，每组 {draft.count} 张</span>
                </div>
              </div>
            )}
          </Popover>
        </div>

        <div className="composer-right">
          {draft.perLine && lineCount > 1 && (
            <span className="chip chip-accent" title="批量提示词">
              <Layers size={12} /> {lineCount} 组 × {draft.count}
            </span>
          )}
          <span className={cx('chip', isEdit && 'chip-accent')}>{isEdit ? '图生图' : '文生图'}</span>
          {agentsOn && (
            <button type="button" className="chip chip-btn" title="已启用 Agents 提示词（点击修改）" onClick={onOpenSettings}>
              <Bot size={12} /> Agents
            </button>
          )}
          <IconButton title="预览请求（dry-run，不发送）" onClick={onPreviewRequest}>
            <FileCode2 size={16} />
          </IconButton>
          <button type="button" className="send-btn" title="生成 (Enter)" disabled={!canSubmit} onClick={onSubmit}>
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
