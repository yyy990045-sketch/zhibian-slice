// 批量 AI 观点分组的纯函数层。
// 真实调用由同源服务端代理完成；本模块只负责 prompt、响应解析和安全覆盖，
// 解析失败时调用方必须继续使用确定性规则，不得把空响应当成成功。
import { classifyText } from './cluster.js';

export const AI_CLUSTER_LABELS = new Set(['support', 'oppose', 'conditional', 'insufficient']);
export const AI_STANCE_VALUES = new Set(['support', 'oppose', 'neutral', 'mixed', 'uncertain']);
export const AI_CONDITIONALITY_VALUES = new Set(['unconditional', 'conditional', 'unclear']);
export const AI_EVIDENCE_VALUES = new Set(['data', 'professional_citation', 'personal_experience', 'lacking_evidence', 'unclear']);

// 规则高置信度的回答不浪费 LLM 配额；只把复杂表达交给批量 AI 校准。
export function selectAiClusterCandidates(items = [], max = 10) {
  return [...items]
    .filter((item) => item && item.id && item.excerpt && (
      item.needsHumanReview
      || item.cluster === 'insufficient'
      || item.conditionalSide === 'mixed'
      || item.conditionality === 'unclear'
      || Number(item.confidence) < 0.55
    ))
    .sort((a, b) => (Number(a.confidence) || 0) - (Number(b.confidence) || 0))
    .slice(0, Math.max(1, max));
}

export function buildClusterPrompt(items = []) {
  const rows = items
    .filter((item) => item && item.id && item.excerpt)
    .slice(0, 10)
    .map((item) => ({ id: String(item.id), text: String(item.excerpt).slice(0, 900) }));
  return [
    '你是知乎观点分组器。仅输出一个 JSON 数组，不要 Markdown，不要解释。',
    '每个元素必须是 {"id":"原id","coreProposition":"核心命题","stance":"support|oppose|neutral|mixed|uncertain","conditionality":"unconditional|conditional|unclear","condition":"成立条件或空字符串","evidenceType":"data|professional_citation|personal_experience|lacking_evidence|unclear","evidenceExcerpt":"原文依据片段","confidence":0到1,"needsHumanReview":true或false,"cluster":"support|oppose|conditional|insufficient"}。',
    'support=明确支持主张；oppose=明确反对主张；conditional=结论依赖前提或分场景；insufficient=没有可判断立场。',
    '先判断完整主张再判断方向：不、没、无、未、并非、没有必要等否定词会翻转方向；“应该……但前提是……”属于带前提的一侧，不要误判为双向。',
    '不要根据点赞数或作者身份推断立场；只根据文本；无法判断就用 stance=uncertain、cluster=insufficient，并把 needsHumanReview=true。不得凭空补充来源或事实。',
    `待分类：${JSON.stringify(rows, null, 0)}`,
  ].join('\n');
}

function extractJsonArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1]);
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 尝试下一个候选片段 */ }
  }
  return null;
}

export function parseClusterResponse(content, sourceItems = []) {
  const parsed = extractJsonArray(content);
  if (!parsed) return { ok: false, items: [], reason: 'invalid_json' };
  const sourceIds = new Set(sourceItems.map((item) => String(item?.id || '')).filter(Boolean));
  const seen = new Set();
  const items = [];
  for (const row of parsed) {
    const id = String(row?.id || '');
    const cluster = String(row?.cluster || '');
    if (!sourceIds.has(id) || seen.has(id) || !AI_CLUSTER_LABELS.has(cluster)) continue;
    const hasDimensions = ['stance', 'conditionality', 'evidenceType', 'confidence', 'needsHumanReview'].some((key) => Object.prototype.hasOwnProperty.call(row || {}, key));
    // 模型偶尔把四簇名复用到 stance 字段；这是已知同义输出，归一到
    // 中性/不确定，而不是放宽到任意字符串或丢弃整批结果。
    const stance = row.stance === 'conditional' ? 'neutral' : row.stance === 'insufficient' ? 'uncertain' : row.stance;
    if (hasDimensions && (!AI_STANCE_VALUES.has(stance) || !AI_CONDITIONALITY_VALUES.has(row.conditionality) || !AI_EVIDENCE_VALUES.has(row.evidenceType))) continue;
    seen.add(id);
    items.push(hasDimensions
      ? {
        id,
        cluster,
        coreProposition: String(row.coreProposition || '').slice(0, 240),
        stance,
        conditionality: row.conditionality,
        condition: String(row.condition || '').slice(0, 240),
        evidenceType: row.evidenceType,
        evidenceExcerpt: String(row.evidenceExcerpt || '').slice(0, 360),
        confidence: Math.max(0, Math.min(1, Number(row.confidence) || 0)),
        needsHumanReview: Boolean(row.needsHumanReview),
        sourceId: id,
      }
      : { id, cluster });
  }
  // 只接受完整结果，避免部分 AI 输出把未分类节点误当成已确认结果。
  if (!sourceIds.size || items.length !== sourceIds.size) return { ok: false, items, reason: 'incomplete' };
  return { ok: true, items, reason: '' };
}

export function applyClusterOverrides(items = [], overrides = []) {
  const byId = new Map(overrides.map((row) => [String(row.id), row]));
  return items.map((item) => {
    const override = byId.get(String(item.id));
    const next = override?.cluster;
    if (!AI_CLUSTER_LABELS.has(next)) return item;
    const hasValidStance = AI_STANCE_VALUES.has(override.stance);
    const stance = next === 'support'
      ? 'support'
      : next === 'oppose'
        ? 'oppose'
        : next === 'insufficient'
          ? 'uncertain'
          : hasValidStance ? override.stance : (item.stance || 'uncertain');
    const conditionality = next === 'conditional'
      ? 'conditional'
      : next === 'insufficient' ? 'unclear' : 'unconditional';
    let conditionalSide = null;
    if (next === 'conditional') {
      // 条件簇仍需保留最终方向；优先使用 AI 的明确方向，其次沿用规则方向。
      conditionalSide = hasValidStance
        ? stance === 'support' ? 'support' : stance === 'oppose' ? 'oppose' : stance === 'mixed' ? 'mixed' : 'neutral'
        : item.conditionalSide;
      if (!conditionalSide) {
        const text = `${item.excerpt || ''} ${item.featuredComment || ''}`;
        const rule = classifyText(text);
        conditionalSide = rule.stanceScore > 0.05 ? 'support' : rule.stanceScore < -0.05 ? 'oppose' : 'neutral';
      }
    }
    const magnitude = Math.max(0.1, Math.min(1, Math.abs(Number(item.stanceScore) || 0.5)));
    const stanceScore = next === 'support'
      ? magnitude
      : next === 'oppose'
        ? -magnitude
        : next === 'conditional'
          ? conditionalSide === 'support' ? magnitude : conditionalSide === 'oppose' ? -magnitude : 0
          : 0;
    const aiContradictsCluster = (next === 'support' && override.stance && override.stance !== 'support')
      || (next === 'oppose' && override.stance && override.stance !== 'oppose')
      || (next === 'insufficient' && override.stance && !['uncertain', 'mixed'].includes(override.stance));
    return {
      ...item,
      cluster: next,
      stance,
      conditionality,
      condition: next === 'conditional' ? (override.condition || item.condition || '') : '',
      evidenceType: override.evidenceType || item.evidenceType || 'unclear',
      coreProposition: override.coreProposition || item.coreProposition || String(item.excerpt || '').slice(0, 240),
      evidenceExcerpt: override.evidenceExcerpt || item.evidenceExcerpt || String(item.excerpt || '').slice(0, 360),
      confidence: override.confidence ?? item.confidence,
      needsHumanReview: Boolean(override.needsHumanReview ?? item.needsHumanReview ?? false) || aiContradictsCluster,
      sourceId: item.sourceId || String(item.id || ''),
      classificationMethod: 'llm',
      // 所有方向派生字段都从最终 cluster/stance/conditionalSide 重建，避免混用规则旧分数。
      stanceScore,
      conditionalSide,
      aiClustered: true,
    };
  });
}
