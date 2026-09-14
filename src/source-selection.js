// source-selection.js — 主流程来源选择（四个方向各一条，其他内容可展开）。
// 目的不是减少证据，而是先回答「我现在最应该读哪一条？」；全量 items 仍保留给海图和展开区。
import { isUsableSource } from './source.js';

export const SOURCE_ROUTE_ORDER = ['support', 'oppose', 'conditional', 'insufficient'];

function sourceScore(item) {
  const usable = isUsableSource(item) ? 1 : 0;
  const authority = Math.max(0, Number(item?.authorityLevel) || 0);
  const heat = Math.log1p(Math.max(0, Number(item?.voteupCount) || 0));
  const relevance = Math.max(0, Number(item?.relevanceScore) || 0);
  const credibility = Math.max(0, Number(item?.credibility) || 0);
  return usable * 1000 + authority * 40 + heat * 3 + relevance * 20 + credibility * 10;
}
function reasonFor(cluster, item) {
  const label = { support: '支持', oppose: '反对', conditional: '条件成立', insufficient: '证据不足' }[cluster] || '该方向';
  const link = isUsableSource(item) ? '有可打开原文' : '暂无可打开原文，先看卡片摘要';
  return `${label}方向中综合权威度、热度与相关性最高；${link}`;
}

/**
 * 返回主流程先展示的代表性来源。重复回答由 fuse() 先处理，本函数不删除原始 items。
 * 每个 UI 航线最多一条，结果稳定且带可解释的 selectionReason。
 */
export function selectRepresentativeSources(items = [], { perCluster = 1 } = {}) {
  const out = [];
  for (const cluster of SOURCE_ROUTE_ORDER) {
    const candidates = items
      .filter((item) => item?.cluster === cluster)
      .sort((a, b) => sourceScore(b) - sourceScore(a) || String(a.id).localeCompare(String(b.id)))
      .slice(0, Math.max(1, perCluster));
    for (const item of candidates) out.push({ ...item, isPrimarySource: true, selectionReason: reasonFor(cluster, item) });
  }
  return out;
}

export function sourceSelectionSummary(items = [], primary = selectRepresentativeSources(items)) {
  return {
    total: items.length,
    primary: primary.length,
    expandable: Math.max(0, items.length - primary.length),
    routes: SOURCE_ROUTE_ORDER.map((cluster) => ({
      cluster,
      total: items.filter((item) => item?.cluster === cluster).length,
      selected: primary.some((item) => item?.cluster === cluster),
    })),
  };
}
