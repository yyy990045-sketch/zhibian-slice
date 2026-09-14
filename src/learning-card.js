// AI 观点学习卡：把一个可核验来源压缩成用户能继续阅读和重新判断的学习单元。
// 默认走规则提取；复杂表达经过 ai-cluster 时会沿用其结构化字段。
import { isUsableSource, sanitizeSourceUrl } from './source.js';
import { buildKeyDisagreement } from './disagreement.js';

const EVIDENCE_LABELS = {
  data: '数据或统计',
  professional_citation: '专业/机构引用',
  personal_experience: '个人经验',
  lacking_evidence: '证据不足',
  unclear: '未明确识别',
};

function score(item) {
  return (Number(item?.authorityLevel) || 0) * 10
    + Math.log1p(Number(item?.voteupCount) || 0)
    + (Number(item?.evidenceCompleteness) || 0) * 5;
}

function pick(items, predicate = () => true) {
  return [...items].filter((item) => predicate(item) && isUsableSource(item)).sort((a, b) => score(b) - score(a))[0] || null;
}

function verifiedExcerpt(item) {
  const original = [...new Set([item?.originalText, item?.excerpt, item?.featuredComment].filter(Boolean))]
    .join(' ').replace(/\s+/g, ' ').trim();
  const proposed = String(item?.evidenceExcerpt || '').replace(/\s+/g, ' ').trim();
  if (proposed && original && original.includes(proposed)) return { text: proposed.slice(0, 360), verified: true };
  return { text: original.slice(0, 360), verified: Boolean(original) && !proposed };
}

function sourceRef(item, role) {
  const excerpt = verifiedExcerpt(item);
  return {
    id: item.id,
    sourceId: item.sourceId || item.id,
    role,
    author: item.author || '未知作者',
    url: sanitizeSourceUrl(item.url),
    excerpt: excerpt.text,
    evidenceExcerptVerified: excerpt.verified,
    confidence: Number(item.confidence) || 0,
    classificationMethod: item.classificationMethod || 'rules',
    needsHumanReview: Boolean(item.needsHumanReview || !excerpt.verified),
  };
}

export function buildLearningCard(items = [], { userStance = null } = {}) {
  const usable = items.filter(isUsableSource);
  if (!usable.length) {
    return {
      ok: false,
      method: 'rules',
      confidence: 0,
      needsHumanReview: true,
      source: null,
      keyDisagreement: '当前没有足够的可核验来源来生成学习卡。',
      condition: '',
      evidenceType: 'unclear',
      evidenceTypeLabel: EVIDENCE_LABELS.unclear,
      overlookedPremise: '没有可靠来源时不生成挑战。',
    };
  }

  const oppositeCluster = userStance === 'support' ? 'oppose' : userStance === 'oppose' ? 'support' : null;
  const candidate = pick(usable, (item) => item.cluster === 'conditional')
    || pick(usable, (item) => oppositeCluster && item.cluster === oppositeCluster)
    || pick(usable);
  const conditional = pick(usable, (item) => item.cluster === 'conditional' && item.condition);
  const disagreement = buildKeyDisagreement(usable);
  const condition = candidate.condition || conditional?.condition || '该回答没有明确写出成立条件，建议回到原文核对上下文。';
  const evidenceType = candidate.evidenceType || 'unclear';
  const method = candidate.classificationMethod === 'llm' ? 'llm' : 'rules';
  const selectedSource = sourceRef(candidate, candidate.cluster === 'conditional' ? '成立条件' : '关键分歧');

  return {
    ok: true,
    method,
    confidence: Number(candidate.confidence) || disagreement.confidence || 0,
    needsHumanReview: Boolean(candidate.needsHumanReview || disagreement.needsHumanReview || !selectedSource.evidenceExcerptVerified),
    source: selectedSource,
    keyDisagreement: disagreement.summary,
    condition,
    evidenceType,
    evidenceTypeLabel: EVIDENCE_LABELS[evidenceType] || EVIDENCE_LABELS.unclear,
    overlookedPremise: condition,
  };
}
