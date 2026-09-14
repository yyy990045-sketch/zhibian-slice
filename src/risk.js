// risk.js — 风险引擎信号（US-13）
// 目的：给「观点光谱」加一层诚实护栏。真实数据噪声 + 规则聚类必然有误判风险，
//       本模块把可量化的风险信号暴露出来，供 UI/挑战卡/评估门禁消费：
//         - 聚集风险（R1 聚集检测）：单一来源/单一作者/单一时间窗占比过高 → 结论易被偏置
//         - 越权承诺信号：正文出现绝对化措辞（一定/必然/所有…）且无对应条件限定
//         - 字段缺失信号：关键字段（author/url/publishTime）缺失比例 → 可追溯性下降
//       每条信号带 level 与建议处置（不做静默调权，只显式标注；真实数据接入后由评估门禁
//       US-18 决定是否升级 LLM 判定——见 ADR-0001）。

import { toNum } from './fields.js';
import { isUsableSource, sanitizeSourceUrl } from './source.js';

// 聚集检测：单一维度占比超过阈值 → 风险信号
export function concentrationSignal(items, { key = 'author', threshold = 0.5, minTotal = 4 } = {}) {
  if (!Array.isArray(items) || items.length < minTotal) return null;
  const counts = new Map();
  let known = 0;
  for (const it of items) {
    const v = String(it?.[key] || '').trim();
    if (!v) continue;
    known += 1;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (known < minTotal) return null;
  const top = Math.max(...counts.values());
  const ratio = top / known;
  if (ratio < threshold) return null;
  return {
    type: 'concentration',
    level: ratio >= 0.8 ? 'high' : 'medium',
    key,
    topValue: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0],
    ratio: Number(ratio.toFixed(2)),
    detail: `单一${keyLabel(key)}占比 ${(ratio * 100).toFixed(0)}%，结论易被该来源偏置`,
  };
}

function keyLabel(key) {
  return { author: '作者', url: '来源', publishTime: '时间窗' }[key] || key;
}

// 绝对化措辞：正文包含强断言词且无条件限定词修饰 → 越权承诺信号
const ABSOLUTE_WORDS = ['一定', '必然', '绝对', '永远', '所有', '全部', '百分百', '肯定', '必须'];
const CONDITION_WORDS = ['如果', '除非', '前提', '通常', '可能', '或许', '有时', '视情况', '一般', '大多'];

export function overclaimSignal(text, { absWords = ABSOLUTE_WORDS, condWords = CONDITION_WORDS } = {}) {
  const t = String(text || '');
  if (!t) return null;
  const hits = absWords.filter((w) => t.includes(w));
  if (!hits.length) return null;
  const hasCondition = condWords.some((w) => t.includes(w));
  if (hasCondition) return null; // 有条件限定 → 不算越权承诺
  return {
    type: 'overclaim',
    level: 'medium',
    words: hits.slice(0, 3),
    detail: `正文含绝对化措辞（${hits.slice(0, 3).join('、')}）且无条件限定`,
  };
}

// 字段缺失：关键可追溯字段缺失比例 → 风险信号
const TRACE_KEYS = ['author', 'url', 'publishTime'];

export function fieldGapSignal(items, { keys = TRACE_KEYS, threshold = 0.5 } = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  const missing = [];
  for (const k of keys) {
    const n = items.filter((it) => !String(it?.[k] || '').trim()).length;
    const ratio = n / items.length;
    if (ratio >= threshold) {
      missing.push({ key: k, ratio: Number(ratio.toFixed(2)) });
    }
  }
  if (!missing.length) return null;
  return {
    type: 'field_gap',
    level: 'medium',
    fields: missing,
    detail: `可追溯字段缺失：${missing.map((m) => `${keyLabel(m.key)} ${Math.round(m.ratio * 100)}%`).join('、')}`,
  };
}

// 汇总：跑全部风险检测，返回有序信号数组（按 level 优先级），无风险返回 []
export function detectRisks(items, texts = []) {
  const signals = [];
  for (const key of ['author', 'url']) {
    const c = concentrationSignal(items, { key });
    if (c) signals.push(c);
  }
  const fg = fieldGapSignal(items);
  if (fg) signals.push(fg);
  // 越权承诺在「检索正文文本」上检测（不依赖 item 结构，容忍缺字段）
  for (const t of texts) {
    const o = overclaimSignal(t);
    if (o) { signals.push(o); break; }
  }
  return signals.sort((a, b) => levelRank(a.level) - levelRank(b.level));
}

function levelRank(l) {
  return { high: 0, medium: 1, low: 2 }[l] ?? 3;
}

// 风险等级汇总：任一 high → 'high'；任一 medium → 'medium'；否则 'low'
export function resolveRiskLevel(signals) {
  if (signals.some((s) => s.level === 'high')) return 'high';
  if (signals.some((s) => s.level === 'medium')) return 'medium';
  return 'low';
}

// 给「观点成长卡」消费：把风险信号转成挑战补充建议（source-gated：无来源不产出，与本项目挑战卡契约一致）
export function buildRiskRecommendations(signals = [], items = []) {
  const usable = (items || []).filter(isUsableSource);
  if (!usable.length) return [];
  const recs = [];
  for (const s of Array.isArray(signals) ? signals : []) {
    if (s.type === 'concentration') {
      const it = usable[0];
      recs.push({
        type: 'risk_concentration',
        text: `风险提示：${s.detail}。建议补充阅读其他作者/来源后再下结论。`,
        sourceRef: { id: it.id, author: it.author || '未知', url: sanitizeSourceUrl(it.url) },
      });
    } else if (s.type === 'field_gap') {
      recs.push({
        type: 'risk_field_gap',
        text: `可追溯性提示：${s.detail}。结论依赖的来源信息不完整，请谨慎采信。`,
        sourceRef: null, // 字段缺失本身就是风险，不强绑来源
      });
    } else if (s.type === 'overclaim') {
      recs.push({
        type: 'risk_overclaim',
        text: `表达提示：${s.detail}，过度断言易被反驳，建议用「可能/通常」等限定词。`,
        sourceRef: null,
      });
    }
  }
  return recs;
}

// 数字助手（避免上层重复解析）
export { toNum };
