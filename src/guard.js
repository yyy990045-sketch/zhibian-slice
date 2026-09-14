// guard.js — 单调风险护栏（风险等级只升不降）
// 核心不变量：最终风险 = max(规则底线, 语义基线, 已验证升级) —— 只升不降。
// LLM/语义判定只允许提升风险等级，绝不允许把规则底线降级（防幻觉击穿 source-gated）。
// 决策契约：对决策输入做 sha256 摘要，便于审计可重放。纯函数、零依赖（node:crypto）。

import { createHash } from 'node:crypto';

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

export function riskRank(level) {
  return ORDER[level] ?? 0; // 未知级别按 low
}

// 只升不降聚合：hardFloor 为规则底线（如规则聚类置信度映射），
// semanticBaseline 为语义/LLM 判定基线，validatedEscalation 为通过证据背书的升级。
export function resolveFinalRisk({ hardFloor = 'low', semanticBaseline = 'low', validatedEscalation = null } = {}) {
  // 规则底线先规范化：未知级别回退 low（防 'unknown' 一路透传到下游）
  let risk = riskRank(hardFloor) > 0 ? hardFloor : 'low';
  for (const candidate of [semanticBaseline, validatedEscalation]) {
    if (candidate && riskRank(candidate) > riskRank(risk)) risk = candidate;
  }
  return risk;
}

// 升级背书：只有证据片段足够具体（≥minChars 字符）才允许 AI 升级风险（防无依据升级）
export function validateEscalation(evidenceText, minChars = 8) {
  const t = String(evidenceText || '').trim();
  if (t.length < minChars) return null;
  return { ok: true, length: t.length };
}

// 决策契约摘要：sha256 可重放（同输入必同摘要）
export function decisionDigest(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}
