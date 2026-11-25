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

export function formatClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameDay ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function relativeTime(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} 个月`;
  return `${Math.floor(mo / 12)} 年`;
}

export function groupSessions(sessions) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const day = 86400000;
  const groups = [
    { key: 'today', label: '今天', items: [] },
    { key: 'yesterday', label: '昨天', items: [] },
    { key: 'week', label: '近 7 天', items: [] },
    { key: 'month', label: '近 30 天', items: [] },
    { key: 'older', label: '更早', items: [] },
  ];
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

export function titleFrom(prompt) {
  const t = String(prompt || '').replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t || '新任务';
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

export const QUALITY_LABELS = {
  '': '默认质量',
  auto: '自动',
  high: '高',
  medium: '中',
  low: '低',
  hd: 'HD',
  standard: '标准',
};

export function qualityLabel(q) {
  return QUALITY_LABELS[q] ?? q;
}

// 尺寸规则和主进程共用一份
export { isUsableSize, normalizeSize, parseRatio, parseSize, SIZE_FORMAT_HINT, sizeMatches, splitSizeList } from '../shared/size.mjs';

export function sizeLabel(s) {
  if (!s) return '默认尺寸';
  if (s === 'auto') return '自动尺寸';
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
