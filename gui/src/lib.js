export const api = window.api;

export const MAX_COUNT = 20;

export function fileUrl(p) {
  return `qtz://img/?p=${encodeURIComponent(p)}`;
}

export function cx(...args) {
  return args.filter(Boolean).join(' ');
}

export function basename(p) {
  return String(p || '').split(/[\\/]/).pop();
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function formatDuration(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// 生成记录的时间：今天的只显示时分，其他日期带上月日（按界面语言的习惯写，24 小时制）
export function formatClock(ts, locale) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const opts = sameDay ? {} : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, { ...opts, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

// 侧边栏的「多久以前」：5 分钟、3 小时、2 天…（单位的写法和单复数交给 Intl）
export function relativeTime(ts, now, t) {
  const unit = (n, u) => new Intl.NumberFormat(t.locale, { style: 'unit', unit: u, unitDisplay: 'short' }).format(n);
  const m = Math.floor(Math.max(0, now - ts) / 60000);
  if (m < 1) return t('time.justNow');
  if (m < 60) return unit(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return unit(h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 30) return unit(d, 'day');
  const mo = Math.floor(d / 30);
  if (mo < 12) return unit(mo, 'month');
  return unit(Math.floor(mo / 12), 'year');
}

// 按时间分组，分组名在界面里用 t(`group.${key}`) 显示
export function groupSessions(sessions) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const day = 86400000;
  const groups = ['today', 'yesterday', 'week', 'month', 'older'].map((key) => ({ key, items: [] }));
  for (const s of sessions) {
    const t = s.updatedAt;
    if (t >= t0) groups[0].items.push(s);
    else if (t >= t0 - day) groups[1].items.push(s);
    else if (t >= t0 - 7 * day) groups[2].items.push(s);
    else if (t >= t0 - 30 * day) groups[3].items.push(s);
    else groups[4].items.push(s);
  }
  return groups.filter((g) => g.items.length);
}

export function aspectOf(size) {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(size || ''));
  if (!m) return '1 / 1';
  return `${m[1]} / ${m[2]}`;
}

export function titleFrom(prompt, t) {
  const s = String(prompt || '').replace(/\s+/g, ' ').trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s || t('session.untitled');
}

export function sessionRunning(s) {
  return (s.runs || []).some((r) => r.status === 'running');
}

export function runStats(run) {
  const done = run.items.filter((i) => i.status === 'done').length;
  const failed = run.items.filter((i) => i.status === 'error').length;
  const active = run.items.filter((i) => i.status === 'running').length;
  return { done, failed, active, total: run.items.length };
}

// 常见的质量值显示成当前语言的说法，其他值原样显示
const QUALITY_KEYS = { '': 'quality.default', auto: 'quality.auto', high: 'quality.high', medium: 'quality.medium', low: 'quality.low', hd: 'quality.hd', standard: 'quality.standard' };

export function qualityLabel(q, t) {
  return Object.hasOwn(QUALITY_KEYS, q) ? t(QUALITY_KEYS[q]) : q;
}

// 尺寸规则和主进程共用一份
export { isUsableSize, normalizeSize, parseRatio, parseSize, sizeHintText, sizeMatches, splitSizeList } from '../shared/size.mjs';

export function sizeLabel(s, t) {
  if (!s) return t('size.default');
  if (s === 'auto') return t('size.auto');
  return s;
}

// 从拖拽/粘贴的 File 列表导入图片，返回 [{path,name}]
export async function importFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.name));
  const out = [];
  for (const f of files) {
    const p = api.files.pathForFile(f);
    if (p) out.push(await api.files.importImagePath(p));
    else out.push(await api.files.importImageData(f.name || 'pasted.png', await f.arrayBuffer()));
  }
  return out;
}
