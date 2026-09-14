// reading-recommendations.js — 根据用户当前立场选择下一步阅读来源。
// 支持/反对必须优先推荐相反簇；中立才回退到可核验来源的综合排序。

import { isUsableSource } from './source.js';

export function selectReadingRecommendations(items = [], userStance = null, limit = 2) {
  const oppositeCluster = userStance === 'support' ? 'oppose' : userStance === 'oppose' ? 'support' : null;
  const usable = (Array.isArray(items) ? items : []).filter(isUsableSource);
  const pool = oppositeCluster
    ? usable.filter((item) => item.cluster === oppositeCluster)
    : usable;
  return [...pool]
    .sort((a, b) => (Number(b.credibility) || 0) - (Number(a.credibility) || 0))
    .slice(0, Math.max(0, limit));
}

export function readingRecommendationLabel(userStance) {
  if (userStance === 'support') return '推荐继续阅读反对侧：';
  if (userStance === 'oppose') return '推荐继续阅读支持侧：';
  return '推荐继续阅读：';
}
