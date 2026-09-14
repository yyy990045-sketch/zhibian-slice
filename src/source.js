// source.js — 来源 URL 清洗与引用质量门禁（剥离内部域名与私有路径）
// 目的：只保留可公开访问的知乎原文 URL；内网/伪造/空 URL 一律清洗，绝不渲染死链；
// 挑战生成的引用锚点只从「可用来源」中选取（source-gated 加固：无来源不产出）。
// 纯函数、零依赖，可在 Node 侧冒烟直接测试。

// 知乎系域名白名单（含子域；link.zhihu.com 为官方短链跳转域）
const ZHIHU_HOSTS = ['zhihu.com', 'developer.zhihu.com'];

function isZhihuHost(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  return ZHIHU_HOSTS.some((base) => h === base || h.endsWith('.' + base));
}

// 清洗来源 URL：非 http(s)、非知乎域、伪造 question 路径一律返回 ''
// 知乎问答路径统一规范化为 /question/<id>（丢弃可变的 answer 尾参，避免拼接歧义）
export function sanitizeSourceUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (!isZhihuHost(u.hostname)) return '';
  // 问答路径必须以完整数字 segment 作为 question id，避免把 123abc
  // 截断成 123 后包装为合法来源。
  if (u.pathname.startsWith('/question/')) {
    const m = u.pathname.match(/^\/question\/(\d+)(?:\/|$)/);
    if (!m) return '';
    return `https://www.zhihu.com/question/${m[1]}`;
  }
  if (u.pathname.includes('/question/')) return '';
  return `${u.origin}${u.pathname}`;
}

// 引用质量门禁：作者非空且清洗后的 URL 可公开访问，才视为「可用来源」
export function isUsableSource(item) {
  return Boolean(item && item.author && sanitizeSourceUrl(item.url));
}
