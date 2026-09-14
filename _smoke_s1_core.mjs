// _smoke_s1_core.mjs — Sprint 1 基础能力 smoke（fields / risk / embedding / providers / audit）
// 运行：node _smoke_s1_core.mjs   （退出码 0 = PASS；非 0 = 有断言失败）
import assert from 'node:assert/strict';

// ---- US-12 field-mapper ----
import { normalizeRecordFields, normalizeRecords, toNum } from './src/fields.js';

const mapped = normalizeRecordFields({
  ContentID: 'c1', Title: '标题', ContentText: '正文<em>高亮</em>', AuthorName: '甲',
  VoteupCount: '1.2万', CommentCount: '3,456', PublishTime: '2026-08-01', Url: 'https://www.zhihu.com/q/1',
});
assert.equal(mapped.id, 'c1');
assert.equal(mapped.title, '标题');
assert.equal(mapped.excerpt, '正文<em>高亮</em>');
assert.equal(mapped.author, '甲');
assert.equal(mapped.voteupCount, 12000, '万单位解析');
assert.equal(mapped.commentCount, 3456, '千分位解析');
assert.equal(mapped.url, 'https://www.zhihu.com/q/1');

// 别名兜底：Title 缺失时走 QuestionTitle
const alias = normalizeRecordFields({ ContentID: 'c2', QuestionTitle: '别名标题', AuthorName: '乙' });
assert.equal(alias.title, '别名标题');

// 空记录过滤
assert.equal(normalizeRecords([{}, { id: 'x', title: 't' }]).length, 1);
assert.equal(toNum('45%'), 45);

// ---- US-13 风险引擎 ----
import { detectRisks, resolveRiskLevel, concentrationSignal, overclaimSignal, fieldGapSignal, buildRiskRecommendations } from './src/risk.js';

const items = [
  { id: 'a', author: '甲', url: 'https://www.zhihu.com/q/1', excerpt: 'x', voteupCount: 1 },
  { id: 'b', author: '甲', url: 'https://www.zhihu.com/q/2', excerpt: 'y', voteupCount: 1 },
  { id: 'c', author: '甲', url: 'https://www.zhihu.com/q/3', excerpt: 'z', voteupCount: 1 },
  { id: 'd', author: '乙', url: 'https://www.zhihu.com/q/4', excerpt: 'w', voteupCount: 1 },
];
const conc = concentrationSignal(items, { key: 'author', minTotal: 3 });
assert.ok(conc && conc.type === 'concentration' && conc.ratio >= 0.5, '2/3 作者聚集被检出');
assert.ok(overclaimSignal('必须做，一定行') && overclaimSignal('一定行').level === 'medium');
assert.equal(overclaimSignal('如果条件满足则一定行'), null, '有条件限定不判越权');
const gap = fieldGapSignal([{ id: 'a', author: '' }, { id: 'b', author: '' }], { keys: ['author'] });
assert.ok(gap && gap.type === 'field_gap');
const signals = detectRisks(items, ['必须立刻行动，一定有效']);
assert.ok(signals.length >= 3, '作者聚集 + 来源聚集 + 越权 + 字段缺失');
assert.ok(['high', 'medium', 'low'].includes(resolveRiskLevel(signals)));
const recs = buildRiskRecommendations(signals, items);
assert.ok(Array.isArray(recs) && recs.length > 0, '风险建议产出');

// ---- US-14 本地 embedding ----
import { embed, normalizeDimensions, cosineSimilarity, textSimilarity, similarTo } from './src/embedding.js';

const v1 = embed('年轻人该不该攒钱');
const v2 = embed('年轻人应当储蓄');
const v3 = embed('今天天气很好');
assert.ok(cosineSimilarity(normalizeDimensions(v1), normalizeDimensions(v1)) > 0.99, '自相似≈1');
assert.ok(textSimilarity('攒钱很重要', '存钱很重要') > textSimilarity('攒钱很重要', '气象卫星发射'), '相似度有区分度');
assert.equal(cosineSimilarity(new Float64Array(256), v1), 0, '零向量余弦=0');
assert.equal(cosineSimilarity(new Float64Array(256), new Float64Array(256)), 0);
assert.equal(normalizeDimensions(new Float64Array(256)).every((x) => x === 0), true, '零向量归一安全');
const sim = similarTo('AI 会不会取代程序员', ['程序员会被 AI 替代吗', '今天的菜价']);
assert.equal(sim[0].index, 0, '相关文本排在第一位');
assert.ok(sim[0].score > sim[1].score, '批量相似排序有区分度');

// ---- US-15 provider-registry ----
import { DEFAULT_DIRECT_MODEL, LLM_PROVIDER_REGISTRY, getProviderByModelName, isProviderMode, clampMaxTokens, providerRequiresSecret, resolveProviderDefinition } from './src/providers.js';

assert.equal(DEFAULT_DIRECT_MODEL, 'zhida-thinking-1p5');
assert.ok(LLM_PROVIDER_REGISTRY['zhida-thinking-1p5'].maxTokens === 2048);
assert.equal(getProviderByModelName('zhida-thinking-1p5').vendor, 'zhihu');
assert.equal(resolveProviderDefinition('nope'), null);
assert.equal(isProviderMode('http'), true);
assert.equal(isProviderMode('ftp'), false);
assert.equal(clampMaxTokens('zhida-thinking-1p5', 999999), 2048, 'maxTokens 钳制到定义上限');
assert.equal(clampMaxTokens('zhida-thinking-1p5', 100), 100, '合法值保留');
assert.equal(clampMaxTokens('zhida-thinking-1p5', 50), 2048, '低于 min 回退定义值');
assert.equal(clampMaxTokens('zhida-thinking-1p5', 'NaN'), 2048, '非法值回退');
assert.equal(providerRequiresSecret('http'), true);
assert.equal(providerRequiresSecret('mock'), false);

// ---- US-09 审计 ----
import { createAuditLog, toAuditEntry, mask } from './src/audit.js';

const audit = createAuditLog({ capacity: 3 });
const e1 = audit.record({ reqId: 'req-abc123', method: 'POST', path: '/api/zhihu/direct-answer', origin: 'http://127.0.0.1:4173', ip: '127.0.0.1', status: 200, ms: 12, query: { q: '秘密关键词' }, body: { query: '秘密正文' } });
assert.ok(e1.seq === 1);
assert.ok(!JSON.stringify(e1).includes('秘密'), '审计条目不包含原文');
audit.record({ reqId: 'r2', method: 'GET', path: '/api/zhihu/stats' });
audit.record({ reqId: 'r3', method: 'GET', path: '/api/zhihu/stats' });
audit.record({ reqId: 'r4', method: 'GET', path: '/api/zhihu/stats' });
assert.equal(audit.snapshot().count, 3, '环形缓冲上限');
assert.equal(audit._seq(), 4);
assert.equal(mask('secret'), 'se***et');
assert.equal(mask('a'), '*');
assert.equal(toAuditEntry({ reqId: 'x', path: '/a', status: 200 }).status, 200);

console.log('PASS: _smoke_s1_core.mjs（fields/risk/embedding/providers/audit）');
