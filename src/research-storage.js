// research-storage.js — 浏览器本地研究运行快照（不保存凭证）
// 只保存用户主动完成过的研究运行、演示/实时结果和立场记录；不保存 OAuth token、Cookie 或 Secret。

import { validateResearchRun } from './research-run.js';

export const RESEARCH_STORAGE_VERSION = 1;
export const RESEARCH_STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function snapshotResearchState(state, savedAt = Date.now()) {
  if (!state?.researchRun || !state.userStance || !Array.isArray(state.items)) return null;
  // 授权收藏夹属于用户数据：即使 token 从不落盘，也不能让结果绕过 token
  // 通过 7 天 research snapshot 自动写入 localStorage。
  if (state.mode === 'favorites' && !state.isDemo) return null;
  return {
    version: RESEARCH_STORAGE_VERSION,
    savedAt,
    researchRun: state.researchRun,
    items: state.items,
    mode: state.mode === 'favorites' ? 'favorites' : 'topic',
    isDemo: Boolean(state.isDemo),
    userStance: state.userStance,
    initialReason: String(state.initialReason || ''),
    openedSourceIds: [...(state.openedSourceIds || [])].map(String),
    secondJudgment: state.secondJudgment || null,
  };
}

export function parseResearchState(raw, now = Date.now()) {
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!value || value.version !== RESEARCH_STORAGE_VERSION) return null;
  const savedAt = Number(value.savedAt);
  if (!Number.isFinite(savedAt) || now - savedAt < 0 || now - savedAt > RESEARCH_STORAGE_TTL_MS) return null;
  if (!Array.isArray(value.items) || !Array.isArray(value.openedSourceIds)) return null;
  if (!['support', 'oppose', 'neutral'].includes(value.userStance)) return null;
  if (value.secondJudgment && !['support', 'oppose', 'neutral'].includes(value.secondJudgment.stance)) return null;
  const validation = validateResearchRun(value.researchRun);
  if (!validation.ok) return null;
  return {
    ...value,
    mode: value.mode === 'favorites' ? 'favorites' : 'topic',
    isDemo: Boolean(value.isDemo),
    initialReason: String(value.initialReason || ''),
    openedSourceIds: [...new Set(value.openedSourceIds.map(String))],
    secondJudgment: value.secondJudgment
      ? { stance: value.secondJudgment.stance, reason: String(value.secondJudgment.reason || '') }
      : null,
  };
}
