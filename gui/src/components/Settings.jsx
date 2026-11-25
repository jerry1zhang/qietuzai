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
import { api, cx, MAX_COUNT, normalizeSize, qualityLabel, sizeHintText, sizeLabel, splitSizeList } from '../lib.js';
import { IconButton, Switch, useToast } from './ui.jsx';
import { LOCALES, resolveLocale, useT } from '../i18n.jsx';

const omitLanguage = ({ language, ...rest }) => rest;

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

// 默认按逗号、顿号和空白拆成多项，不做校验
const splitPlain = (text) => ({ valid: text.split(/[,，、\s]+/).filter(Boolean) });

// 可选尺寸：标准写法统一格式；认不出的（比如有的服务支持的 2K）也允许添加，但原样保留并标成「非标准」，
// 这样厂商自定义的写法能用，输错的也能一眼看出来
const isNonStandardSize = (v) => normalizeSize(v) === null;
const sizeSplitter = (t) => (text) => {
  const { sizes, raw } = splitSizeList(text);
  const list = raw.map((v) => t('common.quote', { text: v })).join(t('common.listSep'));
  return { valid: [...sizes, ...raw], notice: raw.length ? t('settings.nonStandardNotice', { list }) : '' };
};

// split：把输入框的文字拆成 { valid: 要添加的项, notice?: 添加后给用户看的提示 }
// isFlagged：标出需要注意的项（显示成虚线框，悬停看 flagTitle）
function TagEditor({ values, onChange, placeholder, format = (v) => v, split = splitPlain, isFlagged, flagTitle }) {
  const t = useT();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const add = () => {
    if (!text.trim()) return;
    const { valid, notice: note = '' } = split(text);
    if (valid.length) onChange(uniq([...values, ...valid]));
    setText('');
    setNotice(note);
  };
  return (
    <div className="tag-editor">
      <div className="tags">
        {values.map((v) => (
          <span className={cx('tag', isFlagged?.(v) && 'is-flagged')} key={v} title={isFlagged?.(v) ? flagTitle : undefined}>
            {format(v)}
            <button type="button" title={t('common.remove')} onClick={() => onChange(values.filter((x) => x !== v))}>
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
      {notice && <div className="tag-notice">{notice}</div>}
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
  none: 'settings.keyNone',
  keychain: 'settings.keyKeychain',
  basic: 'settings.keyBasic',
  plain: 'settings.keyPlain',
  locked: 'settings.keyLocked',
};

export default function SettingsPage({ settings, onSaved, onLanguageSaved, onBack, onDirtyChange, appInfo }) {
  const toast = useToast();
  const t = useT();
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

  // 语言由语言选择器单独保存（见 changeLanguage），不算在表单的未保存修改里
  const dirty = useMemo(() => JSON.stringify(omitLanguage(form)) !== JSON.stringify(omitLanguage(settings)), [form, settings]);
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
      // 语言由语言选择器单独保存，这里不带上，免得和那次保存交错时用表单里的旧值改回去
      const saved = await api.settings.save(omitLanguage(form));
      setForm(saved);
      onSaved(saved);
      refreshKeyStorage();
      toast.success(t('settings.saved'));
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
      toast.success(t('settings.connectOk', { count: list.length }));
    } catch (e) {
      toast.error(t('settings.connectFail', { error: e.message }));
    } finally {
      setTesting(false);
    }
  };

  const importConfig = async () => {
    try {
      const c = await api.settings.importConfig();
      if (!c) return;
      // 认不出的字段不导入，并明确告诉用户哪些没生效
      const skipped = [];
      // 认得的尺寸统一写法；认不出的（可能是服务商自定义的写法，img.sh 也是原样发送）原样导入并提示
      const rawSize = String(c.size || '').trim();
      const size = rawSize ? normalizeSize(rawSize) ?? rawSize : '';
      const rawNote = rawSize && normalizeSize(rawSize) === null ? t('settings.importRawSize', { size: rawSize }) : '';
      if (c.count && !/^\d+$/.test(c.count)) skipped.push(t('settings.importBadCount', { count: c.count, max: MAX_COUNT }));
      setForm((f) => {
        const n = { ...f };
        if (c.url) n.apiUrl = c.url;
        if (c.token) n.apiKey = c.token;
        if (c.model) {
          n.models = uniq([...f.models, c.model]);
          n.defaultModel = c.model;
        }
        if (size) {
          n.sizes = uniq([...f.sizes, size]);
          n.defaultSize = size;
        }
        if (c.quality !== undefined) {
          n.defaultQuality = c.quality;
          if (c.quality) n.qualities = uniq([...f.qualities, c.quality]);
        }
        if (c.count && /^\d+$/.test(c.count)) n.defaultCount = Math.min(MAX_COUNT, Math.max(1, Number(c.count)));
        return n;
      });
      toast.success(t('settings.imported'));
      if (rawNote) toast.info(rawNote);
      if (skipped.length) toast.error(t('settings.importSkipped', { list: skipped.join(t('common.itemSep')) }));
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

  // 语言选了就保存、马上生效，不用等「保存」：看不懂当前语言的人也能直接切换。
  // 只保存语言这一项，表单里其他没保存的修改保持原样。下拉框显示的是父级已保存的语言（保存中先显示选中的），
  // 不在表单里另存一份：保存还没返回时离开再进设置页，也不会显示旧值
  const [pendingLanguage, setPendingLanguage] = useState(null);
  const changeLanguage = async (language) => {
    setPendingLanguage(language);
    try {
      const saved = await api.settings.save({ language });
      onLanguageSaved(saved.language);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPendingLanguage(null);
    }
  };
  const systemLocale = resolveLocale('system', appInfo?.systemLanguages || navigator.languages);
  const systemLocaleName = LOCALES.find((l) => l.code === systemLocale)?.name;

  return (
    <main className="main">
      <header className="main-header drag">
        <div className="main-title no-drag">
          <IconButton title={t('common.back')} onClick={onBack}>
            <ArrowLeft size={16} />
          </IconButton>
          <span>{t('common.settings')}</span>
        </div>
      </header>

      <div className="settings-scroll">
        <div className="settings-inner">
          <Section title={t('settings.api')} desc={t('settings.apiDesc')}>
            <Row label={t('settings.apiUrl')} hint={endpoint ? t('settings.apiUrlActual', { url: endpoint.generations }) : t('settings.apiUrlExample')}>
              <input
                className="input"
                value={form.apiUrl}
                onChange={(e) => set({ apiUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
              />
            </Row>
            <Row
              label={t('settings.apiKey')}
              hint={
                <>
                  {t(KEY_STORAGE_HINT[keyStorage] || KEY_STORAGE_HINT.none)}
                  {/* 钥匙串暂时解不开旧 Key 时，可以直接删掉它，不必先填一个新的 */}
                  {keyStorage === 'locked' && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() =>
                          api.settings
                            .forgetKey()
                            .then(setKeyStorage)
                            .catch((e) => toast.error(e.message))
                        }
                      >
                        {t('common.delete')}
                      </button>
                    </>
                  )}
                </>
              }
            >
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
                <IconButton title={showKey ? t('common.hide') : t('common.show')} onClick={() => setShowKey((v) => !v)}>
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </IconButton>
              </div>
            </Row>
            <Row label={t('settings.proxy')} hint={t('settings.proxyHint')}>
              <input
                className="input"
                value={form.proxy}
                onChange={(e) => set({ proxy: e.target.value })}
                placeholder={t('settings.proxyPlaceholder')}
                spellCheck={false}
              />
            </Row>
            <div className="set-row-actions">
              <button type="button" className="btn" onClick={testConnection} disabled={testing || !form.apiUrl}>
                {testing ? <Loader2 size={14} className="spin" /> : <Plug size={14} />} {t('settings.testConnection')}
              </button>
              <button type="button" className="btn" onClick={importConfig}>
                <FileInput size={14} /> {t('settings.importConfig')}
              </button>
            </div>
          </Section>

          <Section title={t('settings.models')} desc={t('settings.modelsDesc')}>
            <div className="model-list">
              {form.models.map((m) => (
                <div key={m} className={cx('model-row', m === form.defaultModel && 'is-default')}>
                  <button type="button" className="model-star" title={t('settings.setDefault')} onClick={() => set({ defaultModel: m })}>
                    <Star size={15} fill={m === form.defaultModel ? 'currentColor' : 'none'} />
                  </button>
                  <span className="model-name">{m}</span>
                  {m === form.defaultModel && <span className="chip">{t('common.default')}</span>}
                  <IconButton title={t('common.remove')} size="sm" onClick={() => removeModel(m)} disabled={form.models.length <= 1}>
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
                placeholder={t('settings.addModelPlaceholder')}
                spellCheck={false}
              />
              <button type="button" className="btn" onClick={() => addModel(newModel)} disabled={!newModel.trim()}>
                <Plus size={14} /> {t('common.add')}
              </button>
              <button type="button" className="btn" onClick={testConnection} disabled={testing || !form.apiUrl}>
                {testing ? <Loader2 size={14} className="spin" /> : <DownloadCloud size={14} />} {t('settings.fetchModels')}
              </button>
            </div>
            {remoteModels && (
              <div className="remote-models">
                <div className="remote-models-head">
                  <span className="muted small">{t('settings.remoteModels', { count: remoteModels.length })}</span>
                  <input className="input input-sm" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder={t('settings.filter')} />
                </div>
                <div className="remote-models-list">
                  {filteredRemote.length === 0 && <span className="muted small">{t('settings.noModelMatch')}</span>}
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

          <Section title={t('settings.defaults')} desc={t('settings.defaultsDesc')}>
            <Row label={t('settings.defaultSize')}>
              <select
                className="input select"
                aria-label={t('settings.defaultSize')}
                value={form.defaultSize}
                onChange={(e) => set({ defaultSize: e.target.value })}
              >
                {uniq([...form.sizes, form.defaultSize]).map((s) => (
                  <option key={s} value={s}>
                    {sizeLabel(s, t)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t('settings.sizes')} hint={t('settings.sizesHint')} vertical>
              <TagEditor
                values={form.sizes}
                onChange={(sizes) => set({ sizes })}
                placeholder={t('settings.sizesPlaceholder')}
                split={sizeSplitter(t)}
                isFlagged={isNonStandardSize}
                flagTitle={t('settings.sizesFlag')}
              />
            </Row>
            <Row label={t('settings.sizeInPrompt')} hint={t('settings.sizeInPromptHint', { example: sizeHintText('1536x1024', t) })}>
              <Switch checked={form.sizeInPrompt} onChange={(v) => set({ sizeInPrompt: v })} />
            </Row>
            <Row label={t('settings.defaultQuality')} hint={t('settings.defaultQualityHint')}>
              <select
                className="input select"
                aria-label={t('settings.defaultQuality')}
                value={form.defaultQuality}
                onChange={(e) => set({ defaultQuality: e.target.value })}
              >
                <option value="">{t('settings.qualityUnset')}</option>
                {uniq([...form.qualities, form.defaultQuality]).map((q) => (
                  <option key={q} value={q}>
                    {qualityLabel(q, t)} ({q})
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t('settings.qualities')} vertical>
              <TagEditor values={form.qualities} onChange={(qualities) => set({ qualities })} placeholder={t('settings.qualitiesPlaceholder')} />
            </Row>
            <Row label={t('settings.defaultCount')} hint={t('settings.defaultCountHint', { max: MAX_COUNT })}>
              <NumberInput
                value={form.defaultCount}
                min={1}
                max={MAX_COUNT}
                onChange={(v) => set({ defaultCount: v })}
                suffix={t('composer.unit', { count: form.defaultCount })}
              />
            </Row>
            <Row label={t('settings.concurrency')} hint={t('settings.concurrencyHint')}>
              <NumberInput value={form.concurrency} min={1} max={20} onChange={(v) => set({ concurrency: v })} />
            </Row>
            <Row label={t('settings.timeout')} hint={t('settings.timeoutHint')}>
              <NumberInput value={form.timeoutSec} min={10} max={3600} onChange={(v) => set({ timeoutSec: v })} suffix={t('settings.seconds')} />
            </Row>
          </Section>

          <Section title={t('settings.agents')} desc={t('settings.agentsDesc')}>
            <Row label={t('settings.enable')}>
              <Switch checked={form.agentsEnabled} onChange={(v) => set({ agentsEnabled: v })} />
            </Row>
            <div className="set-block">
              <textarea
                className="input textarea"
                rows={8}
                value={form.agentsPrompt}
                onChange={(e) => set({ agentsPrompt: e.target.value })}
                placeholder={t('settings.agentsPlaceholder')}
                disabled={!form.agentsEnabled}
              />
              {form.agentsEnabled && form.agentsPrompt.trim() && (
                <div className="agents-preview">
                  <div className="muted small">{t('settings.agentsPreview')}</div>
                  <pre>
                    {form.agentsPrompt.trim()}
                    {'\n\n'}
                    <span className="muted">{t('settings.agentsYourPrompt')}</span>
                  </pre>
                </div>
              )}
            </div>
          </Section>

          <Section title={t('settings.output')} desc={t('settings.outputDesc')}>
            <Row label={t('settings.outputDir')} hint={t('settings.outputDirHint')}>
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
                  {t('settings.choose')}
                </button>
                <IconButton title={t('common.open')} onClick={() => api.files.openDir(form.outputDir).catch((e) => toast.error(e.message))}>
                  <FolderOpen size={15} />
                </IconButton>
              </div>
            </Row>
          </Section>

          <Section title={t('settings.appearance')}>
            {/* 不是英文界面时标签后面带上 Language，看不懂当前语言也能找到这一项 */}
            <Row label={t.locale === 'en' ? t('settings.language') : `${t('settings.language')} · Language`} hint={t('settings.languageHint')}>
              <select
                className="input select"
                aria-label={t('settings.language')}
                value={pendingLanguage ?? settings.language}
                onChange={(e) => changeLanguage(e.target.value)}
              >
                <option value="system">{t('settings.languageSystem', { name: systemLocaleName })}</option>
                {LOCALES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t('settings.theme')}>
              <div className="segmented">
                {[
                  ['system', t('settings.themeSystem'), <Monitor size={14} key="m" />],
                  ['light', t('settings.themeLight'), <Sun size={14} key="s" />],
                  ['dark', t('settings.themeDark'), <Moon size={14} key="d" />],
                ].map(([v, label, icon]) => (
                  <button type="button" key={v} className={cx(form.theme === v && 'is-active')} onClick={() => set({ theme: v })}>
                    {icon}
                    {label}
                  </button>
                ))}
              </div>
            </Row>
          </Section>

          <Section title={t('settings.about')}>
            <Row label={t('settings.version')}>
              <span className="muted">{appInfo?.version}</span>
            </Row>
            <Row label={t('settings.dataDir')} hint={t('settings.dataDirHint')}>
              <button type="button" className="link-btn mono" onClick={() => api.files.openDir(appInfo?.userData)}>
                {appInfo?.userData}
              </button>
            </Row>
          </Section>
        </div>
      </div>

      <div className={cx('save-bar', dirty && 'is-visible')}>
        <span>{t('settings.unsaved')}</span>
        <button type="button" className="btn" onClick={() => setForm(settings)}>
          {t('settings.discard')}
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving && <Loader2 size={14} className="spin" />} {t('settings.save')}
        </button>
      </div>
    </main>
  );
}
