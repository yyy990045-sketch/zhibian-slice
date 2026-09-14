// research-run.js — 知辩研究运行与证据包契约（P0）
// 目的：把检索结果、来源、观点派生字段和首次判断收敛成可追溯记录。
// 这是内部纯函数契约，不改变页面、不执行外部写入，也不把无来源文本包装成事实。

import { isUsableSource, sanitizeSourceUrl } from './source.js';

export const RESEARCH_RUN_SCHEMA = 'zhibian-research-run-v1';
export const RESEARCH_RUN_MODES = ['topic', 'favorites'];
export const RESEARCH_RUN_STATUSES = ['ready', 'needs_review', 'completed', 'failed'];
export const INITIAL_STANCES = ['support', 'oppose', 'neutral'];

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const textOf = (value, max = 500) => String(value ?? '').trim().slice(0, max);

function evidenceExcerpt(item) {
  const original = [...new Set([item?.originalText, item?.excerpt, item?.featuredComment]
    .map((value) => textOf(value, 360))
    .filter(Boolean))].join(' ').replace(/\s+/g, ' ').trim();
  const proposed = textOf(item?.evidenceExcerpt, 360);
  if (proposed && original.includes(proposed)) return { text: proposed, verified: true };
  return { text: original, verified: Boolean(original) && !proposed };
}

function propositionOf(item) {
  return textOf(item?.coreProposition || item?.excerpt || item?.originalText, 240);
}

function missingFields(item, proposition, url) {
  const missing = [];
  if (!textOf(item?.id || item?.sourceId, 160)) missing.push('id');
  if (!textOf(item?.author, 160)) missing.push('author');
  if (!url) missing.push('url');
  if (!proposition) missing.push('excerpt');
  return missing;
}

function gapReason(missing) {
  if (missing.length === 1 && missing[0] === 'url') return '来源 URL 不可用';
  if (missing.length === 1 && missing[0] === 'author') return '来源作者不可用';
  if (missing.length === 1 && missing[0] === 'id') return '来源 ID 不可用';
  if (missing.length === 1 && missing[0] === 'excerpt') return '观点正文不可用';
  return `来源字段不可用：${missing.join('、')}`;
}

function normalizeInitialJudgment(judgment) {
  if (judgment == null) return null;
  const stance = textOf(judgment.stance, 32);
  if (!INITIAL_STANCES.includes(stance)) throw new TypeError(`无效的首次立场: ${stance || 'empty'}`);
  return { stance, reason: textOf(judgment.reason, 1000) };
}

/**
 * 将当前检索结果转换为来源、claim、缺口三层证据包。
 * 无作者/无知乎 URL/无正文的条目只进入 gaps，不进入 claims。
 */
export function buildEvidencePack(items = []) {
  const rows = Array.isArray(items) ? items : [];
  const sources = [];
  const claims = [];
  const gaps = [];

  rows.forEach((item, index) => {
    const sourceId = textOf(item?.sourceId || item?.id, 160);
    const url = sanitizeSourceUrl(item?.url);
    const proposition = propositionOf(item);
    const missing = missingFields(item, proposition, url);
    if (missing.length || !isUsableSource({ ...item, url })) {
      const finalMissing = missing.length ? missing : ['url'];
      gaps.push({
        sourceId: sourceId || `item-${index + 1}`,
        reason: gapReason(finalMissing),
        missing: finalMissing,
      });
      return;
    }

    const excerpt = evidenceExcerpt(item);
    sources.push({
      id: sourceId,
      title: textOf(item.title, 500),
      author: textOf(item.author, 160),
      url,
      excerpt: excerpt.text,
      publishTime: textOf(item.publishTime, 80),
      sourceQuality: {
        usable: true,
        authorityLevel: Number(item.authorityLevel) || 0,
        evidenceExcerptVerified: excerpt.verified,
      },
    });
    claims.push({
      sourceId,
      proposition,
      stance: textOf(item.stance, 32) || 'uncertain',
      conditionality: textOf(item.conditionality, 32) || 'unclear',
      evidenceType: textOf(item.evidenceType, 48) || 'unclear',
      condition: textOf(item.condition, 240),
      evidenceExcerpt: excerpt.text,
      evidenceExcerptVerified: excerpt.verified,
      confidence: clamp01(item.confidence),
      classificationMethod: textOf(item.classificationMethod, 32) || 'rules',
      needsHumanReview: Boolean(item.needsHumanReview || !excerpt.verified),
      cluster: textOf(item.cluster, 32) || 'insufficient',
    });
  });

  const humanReviewCount = claims.filter((claim) => claim.needsHumanReview).length;
  const limitations = [];
  if (!sources.length) limitations.push('当前没有同时具备来源 ID、作者和可公开 URL 的可核验来源。');
  if (gaps.length) limitations.push(`${gaps.length} 条结果缺少进入证据链所需字段。`);
  if (humanReviewCount) limitations.push(`${humanReviewCount} 条观点需要人工复核。`);

  return {
    version: 'evidence-pack-v1',
    sources,
    claims,
    gaps,
    limitations,
    counts: {
      totalItems: rows.length,
      sourceCount: sources.length,
      claimCount: claims.length,
      gapCount: gaps.length,
      humanReviewCount,
    },
  };
}

/**
 * 创建可序列化的研究运行快照。快照在进程内保持版本隔离，但不会跨重启持久化。
 */
export function createResearchRun({
  runId,
  mode = 'topic',
  topic = '',
  isDemo = true,
  status = null,
  createdAt = new Date().toISOString(),
  initialJudgment = null,
  items = [],
} = {}) {
  const normalizedMode = textOf(mode, 32);
  if (!textOf(runId, 160)) throw new TypeError('runId 必须非空');
  if (!RESEARCH_RUN_MODES.includes(normalizedMode)) throw new TypeError(`无效的研究运行模式: ${normalizedMode}`);
  if (!textOf(topic, 500)) throw new TypeError('topic 必须非空');
  if (typeof isDemo !== 'boolean') throw new TypeError('isDemo 必须是 boolean');

  const evidencePack = buildEvidencePack(items);
  const needsReview = evidencePack.gaps.length > 0
    || evidencePack.counts.humanReviewCount > 0
    || evidencePack.sources.length === 0;
  const resolvedStatus = status || (needsReview ? 'needs_review' : 'ready');
  if (!RESEARCH_RUN_STATUSES.includes(resolvedStatus)) throw new TypeError(`无效的研究运行状态: ${resolvedStatus}`);

  const run = {
    schema: RESEARCH_RUN_SCHEMA,
    runId: textOf(runId, 160),
    mode: normalizedMode,
    topic: textOf(topic, 500),
    isDemo,
    status: resolvedStatus,
    createdAt: textOf(createdAt, 80),
    initialJudgment: normalizeInitialJudgment(initialJudgment),
    evidencePack,
  };
  const validation = validateResearchRun(run);
  if (!validation.ok) throw new TypeError(`研究运行契约无效: ${validation.errors.join('；')}`);
  return run;
}

export function updateInitialJudgment(run, judgment) {
  const next = cloneSnapshot(run);
  next.initialJudgment = normalizeInitialJudgment(judgment);
  const validation = validateResearchRun(next);
  if (!validation.ok) throw new TypeError(`研究运行契约无效: ${validation.errors.join('；')}`);
  return next;
}

function cloneSnapshot(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * 公共校验入口：防止 claim 脱离当前 sources，防止不规范 URL 和重复来源 ID 进入下游。
 */
export function validateResearchRun(run) {
  const errors = [];
  if (!run || typeof run !== 'object') return { ok: false, errors: ['run 必须是对象'] };
  if (run.schema !== RESEARCH_RUN_SCHEMA) errors.push('schema 不匹配');
  if (!textOf(run.runId, 160)) errors.push('runId 不能为空');
  if (!RESEARCH_RUN_MODES.includes(run.mode)) errors.push('mode 无效');
  if (!textOf(run.topic, 500)) errors.push('topic 不能为空');
  if (typeof run.isDemo !== 'boolean') errors.push('isDemo 必须是 boolean');
  if (!RESEARCH_RUN_STATUSES.includes(run.status)) errors.push('status 无效');
  if (!textOf(run.createdAt, 80) || Number.isNaN(Date.parse(run.createdAt))) errors.push('createdAt 无效');

  const pack = run.evidencePack;
  if (!pack || typeof pack !== 'object') return { ok: false, errors: [...errors, 'evidencePack 必须是对象'] };
  if (!Array.isArray(pack.sources)) errors.push('sources 必须是数组');
  if (!Array.isArray(pack.claims)) errors.push('claims 必须是数组');
  if (!Array.isArray(pack.gaps)) errors.push('gaps 必须是数组');
  if (!Array.isArray(pack.limitations)) errors.push('limitations 必须是数组');
  if (!pack.counts || typeof pack.counts !== 'object') errors.push('counts 必须是对象');
  if (errors.length) return { ok: false, errors };

  const sourceIds = new Set();
  for (const source of pack.sources) {
    const id = textOf(source?.id, 160);
    if (!id) errors.push('source.id 不能为空');
    else if (sourceIds.has(id)) errors.push(`source.id 重复: ${id}`);
    else sourceIds.add(id);
    const cleanUrl = sanitizeSourceUrl(source?.url);
    if (!cleanUrl || cleanUrl !== source.url) errors.push(`source.url 不可核验: ${id || 'unknown'}`);
    if (!textOf(source?.author, 160)) errors.push(`source.author 不能为空: ${id || 'unknown'}`);
  }
  for (const claim of pack.claims) {
    if (!sourceIds.has(textOf(claim?.sourceId, 160))) errors.push(`claim.sourceId 不在 sources: ${claim?.sourceId || 'empty'}`);
    if (!textOf(claim?.proposition, 240)) errors.push(`claim.proposition 不能为空: ${claim?.sourceId || 'unknown'}`);
  }
  for (const gap of pack.gaps) {
    if (!textOf(gap?.sourceId, 160)) errors.push('gap.sourceId 不能为空');
    if (!textOf(gap?.reason, 240)) errors.push(`gap.reason 不能为空: ${gap?.sourceId || 'unknown'}`);
  }
  if (run.initialJudgment != null) {
    if (!INITIAL_STANCES.includes(run.initialJudgment.stance)) errors.push('initialJudgment.stance 无效');
    if (typeof run.initialJudgment.reason !== 'string') errors.push('initialJudgment.reason 必须是字符串');
  }
  const expectedCounts = {
    sourceCount: pack.sources.length,
    claimCount: pack.claims.length,
    gapCount: pack.gaps.length,
    humanReviewCount: pack.claims.filter((claim) => claim.needsHumanReview).length,
  };
  for (const [key, value] of Object.entries(expectedCounts)) {
    if (pack.counts[key] !== value) errors.push(`counts.${key} 不匹配`);
  }
  return { ok: errors.length === 0, errors };
}
