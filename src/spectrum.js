// spectrum.js
// 观点海图布局（确定性渲染，纯前端 SVG）。
// x 轴 = 连续立场分(-1 反对 .. +1 支持)；
// y 轴 = evidenceCompleteness(0..1) 证据/材料完整度；
// 节点大小 = heatScore(0..1) 点赞热度；
// 节点颜色 = 簇；
// 条件成立位置跟随 stanceScore，形态用虚线/菱形表达；
// 证据不足统一置于低位。

import { CLUSTER_META } from './cluster.js';

const MAX_RADIUS = 36; // 浮标最大半径 px；过小会让海图中央大片留白、节点不可读
const MIN_RADIUS = 9;

export const STANCE_ORDER = ['support', 'neutral', 'oppose'];
export const STANCE_META = {
  support: { label: '支持', color: CLUSTER_META.support.color },
  neutral: { label: '中立', color: '#6B7280' },
  oppose: { label: '反对', color: CLUSTER_META.oppose.color },
};
export const ARGUMENT_ORDER = ['direct', 'conditional', 'insufficient'];
export const ARGUMENT_META = {
  direct: { label: '直接判断', color: '#0A3D62' },
  conditional: { label: '条件成立', color: CLUSTER_META.conditional.color },
  insufficient: { label: '证据不足', color: CLUSTER_META.insufficient.color },
};

// 立场与论证性质是两个维度：条件成立/证据不足不是「中立」的别名。
export function stanceBucket(it) {
  if (it?.stance === 'support' || it?.cluster === 'support' || it?.conditionalSide === 'support') return 'support';
  if (it?.stance === 'oppose' || it?.cluster === 'oppose' || it?.conditionalSide === 'oppose') return 'oppose';
  return 'neutral';
}

export function argumentBucket(it) {
  if (it?.cluster === 'insufficient' || it?.evidenceType === 'lacking_evidence') return 'insufficient';
  if (it?.cluster === 'conditional' || it?.conditionality === 'conditional') return 'conditional';
  return 'direct';
}

export function stanceCenterLabel(stanceCounts = {}) {
  const support = stanceCounts.support || 0;
  const oppose = stanceCounts.oppose || 0;
  const neutral = stanceCounts.neutral || 0;
  if (support > oppose && support > neutral) return '整体偏向支持';
  if (oppose > support && oppose > neutral) return '整体偏向反对';
  if (support === oppose && support > 0 && support >= neutral) return '支持与反对势均力敌';
  return '整体中立';
}

function radiusFromHeat(heat) {
  return MIN_RADIUS + heat * (MAX_RADIUS - MIN_RADIUS);
}

// FNV-1a 哈希：对仅末位不同的短 id（如 a4/a7/a9）也能充分散开，避免节点重叠
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 确定性轻微抖动，避免同类节点完全重叠（基于 id 哈希，保证可复现）
function jitter(id, axis) {
  const h = fnv1a(String(id));
  // x / y 用不同的位段取值，使同一节点在两轴上的抖动互不相关
  const n = axis === 'x' ? (h & 0xffff) / 0xffff : ((h >>> 16) & 0xffff) / 0xffff;
  const base = n - 0.5; // -0.5..0.5
  return axis === 'x' ? base * 0.12 : base * 0.08;
}

function conditionalJitter(id, axis) {
  // 条件成立在 x 方向上与主立场拉开一定距离，视觉上仍保持同一侧
  const j = jitter(id, axis);
  return axis === 'x' ? j * 1.8 : j;
}

// 绘图区尺寸（与 app.js 中 SVG 的 padX/padY 保持一致），用于把归一化坐标换算成像素做防重叠
const PLOT_HALF_W = 330; // x 从 -1..1 映射到 660px
const PLOT_H = 328;      // y 从 0..1 映射到 328px
const MIN_NODE_GAP = 6;  // 浮标之间的最小像素间隙

// 底部留给「证据不足」，其余簇从 0.2 起按扎实度分布
const EVID_FLOOR = 0.2;
const EVID_SPAN = 0.75;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

function quantile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function rankPercentile(value, values) {
  if (values.length <= 1) return 0.5;
  let below = 0;
  let equal = 0;
  for (const other of values) {
    if (other < value) below += 1;
    else if (other === value) equal += 1;
  }
  return (below + equal / 2) / values.length;
}

// 话题内视觉缩放：heatScore 保留原始可审计值，visualHeat 只负责当前海图的相对可读性。
// 使用 P10/P90 截尾 + 秩百分位，避免一个异常大号把其余节点压成最小，或让全体都接近最大。
// 同时输出灯塔门槛：只允许在当前话题的高权威/高证据尾部出现，且不低于全局安全下限。
export function computeTopicVisualScale(items) {
  const entries = items.map((it, index) => ({
    id: String(it.id ?? index),
    heat: clamp01(it.heatScore),
    authority: Math.max(1, Number(it.authorityLevel) || 1),
    evidence: clamp01(it.evidenceCompleteness),
  }));
  const heats = entries.map((entry) => entry.heat);
  const q10 = quantile(heats, 0.1);
  const q90 = quantile(heats, 0.9);
  const span = q90 - q10;
  const heatById = new Map();
  for (const entry of entries) {
    const robust = span > 1e-6 ? clamp01((entry.heat - q10) / span) : 0.5;
    const rank = rankPercentile(entry.heat, heats);
    const visualHeat = 0.22 + 0.66 * (robust * 0.7 + rank * 0.3);
    heatById.set(entry.id, Number(visualHeat.toFixed(3)));
  }
  const authorityFloor = Math.max(4, Math.ceil(quantile(entries.map((entry) => entry.authority), 0.75)));
  const evidenceFloor = Math.max(0.6, Number(quantile(entries.map((entry) => entry.evidence), 0.75).toFixed(3)));
  return { heatById, authorityFloor, evidenceFloor };
}

function initialPosition(it) {
  let x;
  let y;
  switch (it.cluster) {
    case 'support':
      // 方向由簇兜底（必在右侧），幅度由 stanceScore 决定
      x = Math.max(0.1, Math.min(1, it.stanceScore)) + jitter(it.id, 'x');
      y = EVID_FLOOR + it.evidenceCompleteness * EVID_SPAN + jitter(it.id, 'y');
      break;
    case 'oppose':
      x = Math.max(-1, Math.min(-0.1, it.stanceScore)) + jitter(it.id, 'x');
      y = EVID_FLOOR + it.evidenceCompleteness * EVID_SPAN + jitter(it.id, 'y');
      break;
    case 'conditional':
      // 位置跟随立场，形态用虚线环表达
      if (it.conditionalSide === 'support') {
        x = Math.max(0.15, Math.min(1, it.stanceScore)) + conditionalJitter(it.id, 'x');
      } else if (it.conditionalSide === 'oppose') {
        x = Math.max(-1, Math.min(-0.15, it.stanceScore)) + conditionalJitter(it.id, 'x');
      } else if (it.conditionalSide === 'mixed') {
        // 双向条件刻意不参考 stanceScore：全局词频无法把信号归属到具体分支，
        // 该分数在双向句上不可靠（a8 正是因此被误判到反对侧），保留任何比例
        // 都等于保留一部分错误方向。只留小幅抖动落在分水岭带内，
        // 方向语义交给视觉标记（左右双色环 + 双向箭头）表达。
        x = Math.max(-0.12, Math.min(0.12, conditionalJitter(it.id, 'x') * 1.6));
      } else {
        x = Math.max(-0.15, Math.min(0.15, it.stanceScore)) + jitter(it.id, 'x');
      }
      y = EVID_FLOOR + it.evidenceCompleteness * EVID_SPAN + jitter(it.id, 'y') * 0.6;
      break;
    case 'insufficient':
      // 证据不足统一置于底部雾区
      x = it.stanceScore + jitter(it.id, 'x') * 1.2;
      y = 0.04 + Math.min(0.12, Math.abs(jitter(it.id, 'y')));
      break;
    default:
      x = it.stanceScore + jitter(it.id, 'x');
      y = EVID_FLOOR + it.evidenceCompleteness * EVID_SPAN + jitter(it.id, 'y');
  }
  return { x, y };
}

// 防重叠松弛：在像素空间推开过近的节点，保持相对次序（确定性，同一输入必得同一输出）
function relaxOverlap(nodes, iterations = 80) {
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const minDist = a.size + b.size + MIN_NODE_GAP;
        let dx = b.px - a.px;
        let dy = b.py - a.py;
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) { dx = 0.5; dy = 0.5; d = Math.hypot(dx, dy); }
        if (d >= minDist) continue;
        const push = (minDist - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        a.px -= ux * push; a.py -= uy * push;
        b.px += ux * push; b.py += uy * push;
        moved = true;
      }
    }
    // 每轮结束夹取回绘图区，避免被推出画布
    for (const n of nodes) {
      n.px = Math.max(-PLOT_HALF_W + n.size, Math.min(PLOT_HALF_W - n.size, n.px));
      n.py = Math.max(n.size, Math.min(PLOT_H - n.size - 14, n.py));
    }
    if (!moved) break;
  }
}

// 重新施加簇的方向 / 低位约束，保证语义不被松弛破坏
function applySemanticClamp(node) {
  const { cluster, conditionalSide } = node;
  if (cluster === 'support') node.x = Math.max(0.06, node.x);
  else if (cluster === 'oppose') node.x = Math.min(-0.06, node.x);
  else if (cluster === 'conditional') {
    if (conditionalSide === 'support') node.x = Math.max(0.08, node.x);
    else if (conditionalSide === 'oppose') node.x = Math.min(-0.08, node.x);
    else if (conditionalSide === 'mixed') node.x = Math.max(-0.16, Math.min(0.16, node.x));
  } else if (cluster === 'insufficient') {
    node.y = Math.min(0.18, node.y);
  }
}

export function computeLayout(items) {
  const scale = computeTopicVisualScale(items);
  const nodes = items.map((it) => {
    const { x, y } = initialPosition(it);
    const visualHeat = scale.heatById.get(String(it.id)) ?? 0.5;
    const size = radiusFromHeat(visualHeat);
    return {
      id: it.id,
      x,
      y,
      px: x * PLOT_HALF_W,
      py: y * PLOT_H,
      size,
      visualHeat,
      // 描边粗细映射 evidenceCompleteness：低扎实度 → 细描边，高扎实度 → 粗描边
      strokeWidth: 1 + it.evidenceCompleteness * 2.5,
      // 填充实心度映射 evidenceCompleteness：低扎实度 → 更透明（大而空），高扎实度 → 更实
      fillOpacity: 0.25 + it.evidenceCompleteness * 0.75,
      heatScore: it.heatScore,
      evidenceCompleteness: it.evidenceCompleteness,
      color: CLUSTER_META[it.cluster].color,
      cluster: it.cluster,
      conditionalSide: it.conditionalSide,
      isLighthouse: Number(it.authorityLevel) >= scale.authorityFloor
        && Number(it.evidenceCompleteness) >= scale.evidenceFloor,
      item: it,
    };
  });

  relaxOverlap(nodes);

  for (const n of nodes) {
    n.x = Number((n.px / PLOT_HALF_W).toFixed(4));
    n.y = Number((n.py / PLOT_H).toFixed(4));
    applySemanticClamp(n);
    n.x = Number(Math.max(-0.98, Math.min(0.98, n.x)).toFixed(4));
    n.y = Number(Math.max(0.02, Math.min(0.98, n.y)).toFixed(4));
    delete n.px;
    delete n.py;
  }
  return nodes;
}

export function computeSummary(items) {
  const counts = { support: 0, oppose: 0, conditional: 0, insufficient: 0 };
  const stanceCounts = { support: 0, neutral: 0, oppose: 0 };
  const argumentCounts = { direct: 0, conditional: 0, insufficient: 0 };
  const evidenceSum = { support: 0, oppose: 0, conditional: 0, insufficient: 0 };
  const heatSum = { support: 0, oppose: 0, conditional: 0, insufficient: 0 };
  for (const it of items) {
    counts[it.cluster] += 1;
    stanceCounts[stanceBucket(it)] += 1;
    argumentCounts[argumentBucket(it)] += 1;
    evidenceSum[it.cluster] += it.evidenceCompleteness;
    heatSum[it.cluster] += it.heatScore;
  }
  const total = items.length || 1;
  const avgEvidence = {};
  const avgHeat = {};
  for (const k of Object.keys(counts)) {
    avgEvidence[k] = counts[k] ? Number((evidenceSum[k] / counts[k]).toFixed(2)) : 0;
    avgHeat[k] = counts[k] ? Number((heatSum[k] / counts[k]).toFixed(2)) : 0;
  }
  // 数值重心仍保留供调试；对外文案必须与立场计数同一套数据，禁止和「条件成立」混算。
  let wsum = 0;
  let w = 0;
  for (const it of items) {
    wsum += it.stanceScore * (it.fusedScore + 0.2);
    w += it.fusedScore + 0.2;
  }
  const center = w ? Number((wsum / w).toFixed(2)) : 0;
  const centerLabel = stanceCenterLabel(stanceCounts);

  const topByCluster = {};
  for (const k of Object.keys(counts)) {
    const arr = items.filter((i) => i.cluster === k).sort((a, b) => b.credibility - a.credibility);
    topByCluster[k] = arr[0] || null;
  }
  return { counts, stanceCounts, argumentCounts, avgEvidence, avgHeat, total, center, centerLabel, topByCluster };
}
