// 尺寸写法的规则。主进程用 require() 加载，界面用 import 加载，两边共用这一份。
//
// 合法的写法有三种：
// - 像素「宽x高」，如 1536x1024（官方接口用这种）
// - 比例「宽:高」，如 16:9（有些中转站只认比例）
// - auto
// 空串表示不指定。

export const SIZE_FORMAT_HINT = '尺寸要写成「宽x高」（如 1536x1024）、比例（如 16:9）或 auto';

const PIXEL_SEP = '[xX×✕✖✗*＊ｘＸ]';
const RATIO_SEP = '[:：]';

// 全角字符（数字、字母、冒号、星号等，以及全角空格）换成半角，中文输入法下打的 ＡＵＴＯ、１０２４ｘ１０２４ 也能认
const halfWidth = (s) => s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');

// 统一写法：像素用 x，比例用半角冒号。格式不对返回 null
export function normalizeSize(input) {
  const s = halfWidth(String(input ?? '')).trim();
  if (!s) return '';
  if (/^auto$/i.test(s)) return 'auto';
  let m = new RegExp(`^(\\d{1,5})\\s*${PIXEL_SEP}\\s*(\\d{1,5})$`).exec(s);
  if (m) return Number(m[1]) > 0 && Number(m[2]) > 0 ? `${Number(m[1])}x${Number(m[2])}` : null;
  m = new RegExp(`^(\\d{1,3})\\s*${RATIO_SEP}\\s*(\\d{1,3})$`).exec(s);
  if (m) return Number(m[1]) > 0 && Number(m[2]) > 0 ? `${Number(m[1])}:${Number(m[2])}` : null;
  return null;
}

// 解读像素尺寸：先按上面的规则校验（任何认得的写法都行，比如 1024X1536），校验不过（如 0x100、abc）返回 null。
// 旧值即使原样发送，也只有合法的才会被拿来生成尺寸描述、判断尺寸是否一致
export function parseSize(size) {
  const m = /^(\d+)x(\d+)$/.exec(normalizeSize(size) || '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// 解读比例尺寸，规则同上
export function parseRatio(size) {
  const m = /^(\d+):(\d+)$/.exec(normalizeSize(size) || '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// 实际尺寸是否符合请求：像素要完全一致；比例按宽高比比较，允许 2% 误差（模型出图常有零头，比如 16:9 出 1672x941）。
// 请求是 auto、空或认不出的写法时判断不了，返回 null
export function sizeMatches(requested, actual) {
  if (!actual) return null;
  const px = parseSize(requested);
  if (px) return px.width === actual.width && px.height === actual.height;
  const r = parseRatio(requested);
  if (r) return Math.abs(actual.width * r.height - actual.height * r.width) <= 0.02 * actual.height * r.width;
  return null;
}

/**
 * 这个尺寸现在还能不能用来发请求：
 * - 符合尺寸规则的
 * - 设置里保存着的（包括服务商自定义的非标准写法）
 * - 历史记录「重新生成」「编辑后重试」带过来、没改过的
 * 主进程发请求前、界面保存设置后检查草稿，用的都是这一条规则
 */
export function isUsableSize(size, settings, { fromHistory = false } = {}) {
  const raw = String(size ?? '').trim();
  if (fromHistory || normalizeSize(raw) !== null) return true;
  return raw === settings.defaultSize || (settings.sizes || []).includes(raw);
}

// 设置页「可选尺寸」一次输入多个，多个值用逗号、顿号、分号或换行分隔。每一段：
// - 整段是标准写法（如「1024 * 1536」）→ 规范化成一个
// - 整段由空格隔开的几个标准写法组成（如「1024x1024 1536x1024」「1024 * 1536 800x800」）→ 规范化成多个
// - 否则整段原样保留（如服务商自定义的「２K」「1:1 方图」，或者输错的「16:9999」），交给调用方标成非标准
// 返回 { sizes: 规范写法列表, raw: 原样保留的原文列表 }
export function splitSizeList(text) {
  const sizes = [];
  const raw = [];
  for (const chunk of String(text || '').split(/[,，、;；\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const whole = normalizeSize(chunk);
    if (whole) {
      sizes.push(whole);
      continue;
    }
    // 用尺寸写法的正则提取（前后必须是空白或边界），去掉这些之后只剩空白，才算整段由标准写法组成
    const token = new RegExp(
      `(?<=^|\\s)(?:\\d{1,5}\\s*${PIXEL_SEP}\\s*\\d{1,5}|\\d{1,3}\\s*${RATIO_SEP}\\s*\\d{1,3}|auto)(?=\\s|$)`,
      'gi',
    );
    const found = [];
    const rest = halfWidth(chunk).replace(token, (m) => {
      found.push(normalizeSize(m));
      return ' ';
    });
    if (found.length > 1 && !rest.trim() && found.every(Boolean)) sizes.push(...found);
    else raw.push(chunk);
  }
  return { sizes, raw };
}
