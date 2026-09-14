// disagreement.js — 来源约束的关键分歧摘要。
// 规则无法抽取事实结论时只返回“未充分”，不让摘要变成无来源的 AI 判断。
import { isUsableSource, sanitizeSourceUrl } from './source.js';

const ORDER = ['support', 'oppose', 'conditional', 'insufficient'];
const LABELS = { support: '支持侧', oppose: '反对侧', conditional: '条件侧', insufficient: '证据不足侧' };

function best(items) {
  return [...items].filter(isUsableSource).sort((a, b) =>
    (Number(b.authorityLevel) || 0) * 10 + Math.log1p(Number(b.voteupCount) || 0)
      - ((Number(a.authorityLevel) || 0) * 10 + Math.log1p(Number(a.voteupCount) || 0))
  )[0] || null;
}
function excerpt(item) {
  const text = String(item?.coreProposition || item?.excerpt || '').replace(/\s+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

export function buildKeyDisagreement(items = []) {
  const byCluster = Object.fromEntries(ORDER.map((cluster) => [cluster, best(items.filter((item) => item?.cluster === cluster))]));
  const support = byCluster.support;
  const oppose = byCluster.oppose;
  const conditional = byCluster.conditional;
  const refs = [support, oppose, conditional].filter(Boolean).map((item) => ({ id: item.id, author: item.author, url: sanitizeSourceUrl(item.url) }));
  if (!support && !oppose && !conditional) {
    return { ok: false, summary: '当前没有足够的可核验来源来提取关键分歧。', refs: [], confidence: 0, needsHumanReview: true, method: 'rules' };
  }
  const parts = [];
  if (support) parts.push(`${LABELS.support}强调“${excerpt(support)}”`);
  if (oppose) parts.push(`${LABELS.oppose}强调“${excerpt(oppose)}”`);
  if (conditional) parts.push(`${LABELS.conditional}补充前提“${excerpt(conditional)}”`);
  return {
    ok: Boolean(support && oppose),
    summary: parts.join('；') + (support && oppose ? '。真正的分歧在于：结论是否可以脱离这些条件成立。' : '。当前仍缺少相反方向的可核验来源。'),
    refs,
    confidence: support && oppose ? 0.72 : 0.42,
    needsHumanReview: !(support && oppose),
    method: 'rules',
  };
}
