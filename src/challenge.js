// challenge.js
// 确定性、source-gated 挑战生成器（不依赖 LLM）。
// 设计原则：结论必须绑定来源，无来源不产出。
// 目标：用「知乎真实内容」补充不同方向、成立条件和证据边界，
// 而不是生成「我去查了一下」式的模板废话——每条挑战都引用具体片段与作者。

import { sanitizeSourceUrl, isUsableSource } from './source.js';

export const CHALLENGE_TYPES = {
  blind_spot: '不同方向',
  missing_condition: '成立条件',
  evidence_gap: '可核验材料较少',
};

// 选簇中「权威度 × 点赞」最高、且来源可用（作者非空 + URL 可公开访问）的条目作为引用锚点；
// 全部条目无可用来源时返回 null → 该簇不产出挑战（source-gated：无来源不产出）。
function bestSource(items) {
  if (!items || !items.length) return null;
  const usable = items.filter(isUsableSource);
  if (!usable.length) return null;
  return [...usable].sort(
    (a, b) =>
      b.authorityLevel * Math.log1p(b.voteupCount) -
      a.authorityLevel * Math.log1p(a.voteupCount)
  )[0];
}

function snippet(ex, n = 44) {
  if (!ex) return '（无摘要）';
  return ex.length > n ? ex.slice(0, n) + '…' : ex;
}

const STANCE_KEY = {
  支持: 'support',
  反对: 'oppose',
  条件成立: 'conditional',
  证据不足: 'insufficient',
};

// 入参：userStance（中文四选一或空）、clusters（四簇，含 items）、summary（total 等）
// 返回：challenges[]，每条必含 sourceRef（id/author/url）；无来源可引则不产出该条（source-gated）。
export function generateChallenges({ userStance, clusters = {}, summary = {} }) {
  const out = [];
  const itemsOf = (t) => clusters[t]?.items || [];
  const userKey = STANCE_KEY[userStance];

  // 1) 不同方向：用户立场与另一方向的可用来源不同
  if (userKey === 'support' && itemsOf('oppose').length) {
    const s = bestSource(itemsOf('oppose'));
    if (s)
      out.push({
        type: 'blind_spot',
        text: `你目前倾向「支持」。这条回答从另一个方向提出了一个值得核对的理由：${snippet(s.excerpt)}（作者 ${s.author}）`,
        sourceRef: { id: s.id, author: s.author, url: sanitizeSourceUrl(s.url) },
      });
  }
  if (userKey === 'oppose' && itemsOf('support').length) {
    const s = bestSource(itemsOf('support'));
    if (s)
      out.push({
        type: 'blind_spot',
        text: `你目前倾向「反对」。这条回答从另一个方向提出了一个值得核对的理由：${snippet(s.excerpt)}（作者 ${s.author}）`,
        sourceRef: { id: s.id, author: s.author, url: sanitizeSourceUrl(s.url) },
      });
  }

  // 2) 遗漏条件：存在「条件成立」簇 → 立场可能只在条件下成立
  if (itemsOf('conditional').length) {
    const s = bestSource(itemsOf('conditional'));
    if (s)
      out.push({
        type: 'missing_condition',
        text: `这条回答补充了一个可能影响判断的条件：${snippet(s.excerpt)}（作者 ${s.author}）`,
        sourceRef: { id: s.id, author: s.author, url: sanitizeSourceUrl(s.url) },
      });
  }

  // 3) 证据不足：占比偏高，或全簇皆为证据不足 → 谨慎下结论
  const total = summary.total || 0;
  const insuff = itemsOf('insufficient');
  const insuffRatio = total ? insuff.length / total : 0;
  const onlyInsufficient =
    insuff.length && !itemsOf('support').length && !itemsOf('oppose').length && !itemsOf('conditional').length;
  if (insuffRatio >= 0.25 || onlyInsufficient) {
    const s = bestSource(insuff);
    if (s)
      out.push({
        type: 'evidence_gap',
        text: `在当前检索到的回答里，可核验材料相对较少。可以先看看这条回答用了什么依据：${snippet(s.excerpt)}（作者 ${s.author}）`,
        sourceRef: { id: s.id, author: s.author, url: sanitizeSourceUrl(s.url) },
      });
  }

  return out;
}
