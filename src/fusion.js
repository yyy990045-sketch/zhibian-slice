// fusion.js
// 融合排序与去重（纯确定性，不依赖 LLM）。
// 输入：原始 items（来自 adapter）；输出：带 fusedScore 的降序数组。

const W = { relevance: 0.4, vote: 0.28, comment: 0.12, authority: 0.2 };

function logNorm(v) {
  if (!v || v <= 0) return 0;
  // log1p 压缩长尾，避免高赞项一家独大
  return Math.log1p(v) / Math.log1p(20000);
}

function authNorm(level) {
  return Math.max(0, Math.min(1, (Number(level) - 1) / 4)); // 1->0, 5->1
}

function recencyPenalty(publishTime) {
  if (!publishTime) return 0;
  const t = new Date(publishTime).getTime();
  if (Number.isNaN(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  // 超过 3 年缓慢衰减，封顶 0.15
  return Math.min(0.15, Math.max(0, days / 1095) * 0.15);
}

function identityKey(item) {
  const id = String(item?.id || item?.sourceId || '').trim();
  if (id) return `id:${id}`;
  const url = String(item?.url || '').trim().replace(/[?#].*$/, '').replace(/\/$/, '');
  if (url) return `url:${url}`;
  const author = String(item?.author || '').trim();
  const title = String(item?.title || '').trim().replace(/\s+/g, ' ');
  const excerpt = String(item?.excerpt || '').trim().replace(/\s+/g, ' ');
  // 没有稳定身份时只对标题和正文都相同的记录去重；相似标题不再足以删除观点。
  return `text:${author}::${title}::${excerpt}`;
}

export function fuse(items) {
  const seen = new Set();
  const fused = [];
  for (const it of items) {
    // 优先使用稳定 ID/原始 URL；无身份时要求作者、标题和正文完全一致。
    const key = identityKey(it);
    if (seen.has(key)) continue;
    seen.add(key);

    const rel = Math.max(0, Math.min(1, Number(it.relevanceScore) || 0));
    const score =
      W.relevance * rel +
      W.vote * logNorm(it.voteupCount) +
      W.comment * logNorm(it.commentCount) +
      W.authority * authNorm(it.authorityLevel) -
      recencyPenalty(it.publishTime);

    fused.push({ ...it, fusedScore: Number(score.toFixed(4)) });
  }
  fused.sort((a, b) => b.fusedScore - a.fusedScore);
  return fused;
}

// ---------- 多路 RRF 融合（跨通道累加、去重并标记来源通道） ----------
// 输入：channels = [{ source: 'search'|'hot'|'local'|..., items: [...] }, ...]
// 对每路按排名给 RRF 分（1/(RRF_K+rank)），跨路累加；按总分排序、去重、打通道标记。
// 单路输入时行为退化为"按 RRF 分排序"（仍保留 fusedScore 原值，兼容下游消费）。
const RRF_K = 60;

export function rrfFuse(channels, { topK = 20 } = {}) {
  const rankMap = new Map();
  for (const ch of channels) {
    if (!ch || !Array.isArray(ch.items)) continue;
    const source = ch.source || 'unknown';
    ch.items.forEach((it, i) => {
      // 与 fuse 使用同一身份契约，避免跨通道把相似标题的不同观点合并。
      const key = identityKey(it);
      const entry = rankMap.get(key) || { item: it, rrf: 0, sources: new Set() };
      entry.rrf += 1 / (RRF_K + i + 1);
      entry.sources.add(source);
      entry.item = it;
      rankMap.set(key, entry);
    });
  }
  return [...rankMap.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, topK)
    .map((e) => ({
      ...e.item,
      rrfScore: Number(e.rrf.toFixed(4)),
      channels: [...e.sources].sort(),
    }));
}
