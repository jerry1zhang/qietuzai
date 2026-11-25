import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Plug,
  FileInput,
  Plus,
  Trash2,
  Star,
  DownloadCloud,
  FolderOpen,
  Loader2,
  X,
  Monitor,
  Sun,
  Moon,
} from 'lucide-react';
import { api, cx, MAX_COUNT, qualityLabel, sizeLabel } from '../lib.js';
import { IconButton, Switch, useToast } from './ui.jsx';

function uniq(list) {
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

function Section({ id, title, desc, children }) {
  return (
    <section className="set-section" id={id}>
      <div className="set-section-head">
        <h2>{title}</h2>
        {desc && <p>{desc}</p>}
      </div>
      <div className="set-card">{children}</div>
    </section>
  );
}

function Row({ label, hint, children, vertical }) {
  return (
    <div className={cx('set-row', vertical && 'is-vertical')}>
      <div className="set-row-label">
        <div>{label}</div>
        {hint && <div className="set-row-hint">{hint}</div>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function TagEditor({ values, onChange, placeholder, format = (v) => v }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(/[,，\s]+/).filter(Boolean);
    if (parts.length) onChange(uniq([...values, ...parts]));
    setText('');
  };
  return (
    <div className="tags">
      {values.map((v) => (
        <span className="tag" key={v}>
          {format(v)}
          <button type="button" title="移除" onClick={() => onChange(values.filter((x) => x !== v))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

function NumberInput({ value, onChange, min, max, suffix }) {
  return (
    <div className="num-input">
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        onBlur={() => onChange(Math.min(max, Math.max(min, Number.parseInt(value, 10) || min)))}
      />
      {suffix && <span>{suffix}</span>}
    </div>
  );
}

const KEY_STORAGE_HINT = {
  none: '保存在本机，系统支持时会用钥匙串加密',
  keychain: '已用系统钥匙串加密保存在本机',
  basic: '系统没有可用的钥匙串，Key 只做了简单加密，保存在仅当前用户可读的 settings.json',
  plain: '系统不支持加密，Key 以明文保存在仅当前用户可读的 settings.json',
};

export default function SettingsPage({ settings, onSaved, onBack, onDirtyChange, appInfo }) {
  const toast = useToast();
  const [form, setForm] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [remoteModels, setRemoteModels] = useState(null);
  const [modelFilter, setModelFilter] = useState('image');
  const [newModel, setNewModel] = useState('');
  const [endpoint, setEndpoint] = useState(null);
  const [saving, setSaving] = useState(false);
  const [keyStorage, setKeyStorage] = useState(null);

  const refreshKeyStorage = () =>
    api.settings
      .keyStorage()
      .then(setKeyStorage)
      .catch(() => setKeyStorage(null));
  useEffect(() => {
    refreshKeyStorage();
  }, []);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(settings), [form, settings]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    let alive = true;
    api.settings
      .resolveEndpoint(form.apiUrl)
      .then((r) => alive && setEndpoint(r))
      .catch(() => alive && setEndpoint(null));
    return () => {
      alive = false;
    };
  }, [form.apiUrl]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.settings.save(form);
      setForm(saved);
      onSaved(saved);
      refreshKeyStorage();
      toast.success('设置已保存');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const list = await api.settings.fetchModels(form.apiUrl, form.apiKey, form.proxy);
      setRemoteModels(list);
      toast.success(`连接成功，接口返回 ${list.length} 个模型`);
    } catch (e) {
      toast.error(`连接失败：${e.message}`);
    } finally {
      setTesting(false);
    }
  };

  const importConfig = async () => {
    try {
      const c = await api.settings.importConfig();
      if (!c) return;
      setForm((f) => {
        const n = { ...f };
        if (c.url) n.apiUrl = c.url;
        if (c.token) n.apiKey = c.token;
        if (c.model) {
          n.models = uniq([...f.models, c.model]);
          n.defaultModel = c.model;
        }
        if (c.size) {
          n.sizes = uniq([...f.sizes, c.size]);
          n.defaultSize = c.size;
        }
        if (c.quality !== undefined) {
          n.defaultQuality = c.quality;
          if (c.quality) n.qualities = uniq([...f.qualities, c.quality]);
        }
        if (c.count && /^\d+$/.test(c.count)) n.defaultCount = Math.min(MAX_COUNT, Math.max(1, Number(c.count)));
        return n;
      });
      toast.success('已从 img.config 导入，确认后点「保存」');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const addModel = (m) => {
    const v = String(m || '').trim();
    if (!v) return;
    set({ models: uniq([...form.models, v]) });
    setNewModel('');
  };

  const removeModel = (m) => {
    const models = form.models.filter((x) => x !== m);
    set({ models, defaultModel: form.defaultModel === m ? models[0] || '' : form.defaultModel });
  };

  const filteredRemote = (remoteModels || []).filter((m) => !modelFilter || m.toLowerCase().includes(modelFilter.toLowerCase()));

  return (
    <main className="main">
      <header className="main-header drag">
        <div className="main-title no-drag">
          <IconButton title="返回" onClick={onBack}>
            <ArrowLeft size={16} />
          </IconButton>
          <span>设置</span>
        </div>
      </header>

      <div className="settings-scroll">
        <div className="settings-inner">
          <Section title="接口" desc="兼容 OpenAI Images API（/v1/images/generations 与 /v1/images/edits）的服务都可以使用。">
            <Row label="接口地址" hint={endpoint ? `实际请求：${endpoint.generations}` : '例如 https://api.openai.com/v1'}>
              <input
                className="input"
                value={form.apiUrl}
                onChange={(e) => set({ apiUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
              />
            </Row>
            <Row label="API Key" hint={KEY_STORAGE_HINT[keyStorage] || KEY_STORAGE_HINT.none}>
              <div className="input-group">
                <input
                  className="input"
                  type={showKey ? 'text' : 'password'}
                  value={form.apiKey}
                  onChange={(e) => set({ apiKey: e.target.value })}
                  placeholder="sk-..."
                  spellCheck={false}
                  autoComplete="off"
                />
                <IconButton title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey((v) => !v)}>
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </IconButton>
              </div>
            </Row>
            <Row label="代理" hint="可选，例如 http://127.0.0.1:7890；留空则使用系统代理">
              <input
                className="input"
                value={form.proxy}
                onChange={(e) => set({ proxy: e.target.value })}
                placeholder="留空 = 跟随系统"
                spellCheck={false}
              />
            </Row>
            <div className="set-row-actions">
              <button type="button" className="btn" onClick={testConnection} disabled={testing || !form.apiUrl}>
                {testing ? <Loader2 size={14} className="spin" /> : <Plug size={14} />} 测试连接
              </button>
              <button type="button" className="btn" onClick={importConfig}>
                <FileInput size={14} /> 从 img.config 导入
              </button>
            </div>
          </Section>

          <Section title="模型" desc="输入框里可切换的模型。带星标的是默认模型。">
            <div className="model-list">
              {form.models.map((m) => (
                <div key={m} className={cx('model-row', m === form.defaultModel && 'is-default')}>
                  <button type="button" className="model-star" title="设为默认" onClick={() => set({ defaultModel: m })}>
                    <Star size={15} fill={m === form.defaultModel ? 'currentColor' : 'none'} />
                  </button>
                  <span className="model-name">{m}</span>
                  {m === form.defaultModel && <span className="chip">默认</span>}
                  <IconButton title="移除" size="sm" onClick={() => removeModel(m)} disabled={form.models.length <= 1}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
            <div className="model-add">
              <input
                className="input"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) addModel(newModel);
                }}
                placeholder="添加模型，例如 gpt-image-1"
                spellCheck={false}
              />
              <button type="button" className="btn" onClick={() => addModel(newModel)} disabled={!newModel.trim()}>
                <Plus size={14} /> 添加
              </button>
              <button type="button" className="btn" onClick={testConnection} disabled={testing || !form.apiUrl}>
                {testing ? <Loader2 size={14} className="spin" /> : <DownloadCloud size={14} />} 从接口获取
              </button>
            </div>
            {remoteModels && (
              <div className="remote-models">
                <div className="remote-models-head">
                  <span className="muted small">点击添加（共 {remoteModels.length} 个）</span>
                  <input className="input input-sm" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder="过滤" />
                </div>
                <div className="remote-models-list">
                  {filteredRemote.length === 0 && <span className="muted small">没有匹配的模型</span>}
                  {filteredRemote.map((m) => (
                    <button
                      type="button"
                      key={m}
                      className={cx('tag tag-btn', form.models.includes(m) && 'is-added')}
                      onClick={() => (form.models.includes(m) ? removeModel(m) : addModel(m))}
                    >
                      {form.models.includes(m) ? '✓ ' : '+ '}
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Section>

          <Section title="默认生成参数" desc="新建任务时输入框的默认值，生成时也可以随时在输入框里切换。">
            <Row label="默认尺寸">
              <select className="input select" value={form.defaultSize} onChange={(e) => set({ defaultSize: e.target.value })}>
                {uniq([...form.sizes, form.defaultSize]).map((s) => (
                  <option key={s} value={s}>
                    {sizeLabel(s)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="可选尺寸" hint="回车添加，如 1792x1024" vertical>
              <TagEditor values={form.sizes} onChange={(sizes) => set({ sizes })} placeholder="添加尺寸…" />
            </Row>
            <Row label="默认质量" hint="不指定时请求里不带 quality 字段">
              <select className="input select" value={form.defaultQuality} onChange={(e) => set({ defaultQuality: e.target.value })}>
                <option value="">不指定</option>
                {uniq([...form.qualities, form.defaultQuality]).map((q) => (
                  <option key={q} value={q}>
                    {qualityLabel(q)} ({q})
                  </option>
                ))}
              </select>
            </Row>
            <Row label="可选质量" vertical>
              <TagEditor values={form.qualities} onChange={(qualities) => set({ qualities })} placeholder="添加质量值…" />
            </Row>
            <Row label="默认数量" hint={`每次生成的张数，1 - ${MAX_COUNT}`}>
              <NumberInput value={form.defaultCount} min={1} max={MAX_COUNT} onChange={(v) => set({ defaultCount: v })} suffix="张" />
            </Row>
            <Row label="并发数" hint="所有任务加起来最多同时发出的请求数，超出的排队（对应 IMG_JOBS）">
              <NumberInput value={form.concurrency} min={1} max={20} onChange={(v) => set({ concurrency: v })} />
            </Row>
            <Row label="超时" hint="单次请求最长等待时间">
              <NumberInput value={form.timeoutSec} min={10} max={3600} onChange={(v) => set({ timeoutSec: v })} suffix="秒" />
            </Row>
          </Section>

          <Section
            title="Agents 提示词"
            desc="每次请求都会把这段内容加在提示词最前面（中间空一行），适合放统一的风格、品牌规范、禁止项等。"
          >
            <Row label="启用">
              <Switch checked={form.agentsEnabled} onChange={(v) => set({ agentsEnabled: v })} />
            </Row>
            <div className="set-block">
              <textarea
                className="input textarea"
                rows={8}
                value={form.agentsPrompt}
                onChange={(e) => set({ agentsPrompt: e.target.value })}
                placeholder={'例如：\n你是一名资深 UI 设计师，输出的图片需要：\n- 扁平风格，主色 #FF6A3D\n- 不要出现任何文字和水印'}
                disabled={!form.agentsEnabled}
              />
              {form.agentsEnabled && form.agentsPrompt.trim() && (
                <div className="agents-preview">
                  <div className="muted small">实际发送示例</div>
                  <pre>
                    {form.agentsPrompt.trim()}
                    {'\n\n'}
                    <span className="muted">{'<你在输入框里写的提示词>'}</span>
                  </pre>
                </div>
              )}
            </div>
          </Section>

          <Section title="输出" desc="生成的图片保存位置。">
            <Row label="保存目录" hint="可以用 ~ 表示主目录；相对路径按主目录计算">
              <div className="input-group">
                <input className="input" value={form.outputDir} onChange={(e) => set({ outputDir: e.target.value })} spellCheck={false} />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const d = await api.settings.pickDir(form.outputDir);
                    if (d) set({ outputDir: d });
                  }}
                >
                  选择…
                </button>
                <IconButton title="打开" onClick={() => api.files.openDir(form.outputDir).catch((e) => toast.error(e.message))}>
                  <FolderOpen size={15} />
                </IconButton>
              </div>
            </Row>
          </Section>

          <Section title="外观">
            <Row label="主题">
              <div className="segmented">
                {[
                  ['system', '跟随系统', <Monitor size={14} key="m" />],
                  ['light', '浅色', <Sun size={14} key="s" />],
                  ['dark', '深色', <Moon size={14} key="d" />],
                ].map(([v, label, icon]) => (
                  <button type="button" key={v} className={cx(form.theme === v && 'is-active')} onClick={() => set({ theme: v })}>
                    {icon}
                    {label}
                  </button>
                ))}
              </div>
            </Row>
          </Section>

          <Section title="关于">
            <Row label="版本">
              <span className="muted">{appInfo?.version}</span>
            </Row>
            <Row label="数据目录" hint="设置、历史记录和参考图副本">
              <button type="button" className="link-btn mono" onClick={() => api.files.openDir(appInfo?.userData)}>
                {appInfo?.userData}
              </button>
            </Row>
          </Section>
        </div>
      </div>

      <div className={cx('save-bar', dirty && 'is-visible')}>
        <span>有未保存的修改</span>
        <button type="button" className="btn" onClick={() => setForm(settings)}>
          放弃
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving && <Loader2 size={14} className="spin" />} 保存
        </button>
      </div>
    </main>
  );
}
