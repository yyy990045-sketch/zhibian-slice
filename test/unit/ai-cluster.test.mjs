import test from 'node:test';
import assert from 'node:assert/strict';
import { applyClusterOverrides, buildClusterPrompt, parseClusterResponse, selectAiClusterCandidates } from '../../src/ai-cluster.js';
import { cluster } from '../../src/cluster.js';

const items = [
  { id: 'a', excerpt: '普通人应该学一点编程。' },
  { id: 'b', excerpt: '远程办公不应该全面普及。' },
];

test('buildClusterPrompt limits rows and states the four labels', () => {
  const prompt = buildClusterPrompt(items);
  assert.match(prompt, /support\|oppose\|conditional\|insufficient/);
  assert.match(prompt, /没有必要/);
  assert.match(prompt, /但前提/);
  assert.match(prompt, /"id":"a"/);
});

test('parseClusterResponse accepts fenced JSON and rejects incomplete output', () => {
  const ok = parseClusterResponse('```json\n[{"id":"a","cluster":"support"},{"id":"b","cluster":"oppose"}]\n```', items);
  assert.deepEqual(ok, { ok: true, items: [{ id: 'a', cluster: 'support' }, { id: 'b', cluster: 'oppose' }], reason: '' });
  const incomplete = parseClusterResponse('[{"id":"a","cluster":"support"}]', items);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, 'incomplete');
});

test('parseClusterResponse accepts traceable three-dimensional AI output', () => {
  const content = JSON.stringify([
    {
      id: 'a', cluster: 'conditional', coreProposition: '应当学习，但要看时间',
      stance: 'support', conditionality: 'conditional', condition: '时间充足',
      evidenceType: 'personal_experience', evidenceExcerpt: '我实践过', confidence: 0.82, needsHumanReview: false,
    },
    {
      id: 'b', cluster: 'insufficient', coreProposition: '',
      stance: 'uncertain', conditionality: 'unclear', condition: '',
      evidenceType: 'lacking_evidence', evidenceExcerpt: '暂无定论', confidence: 0.31, needsHumanReview: true,
    },
  ]);
  const result = parseClusterResponse(content, items);
  assert.equal(result.ok, true);
  assert.equal(result.items[0].sourceId, 'a');
  assert.equal(result.items[0].stance, 'support');
  assert.equal(result.items[1].needsHumanReview, true);
});

test('parseClusterResponse normalizes known model synonyms without weakening the schema', () => {
  const content = JSON.stringify([
    { id: 'a', cluster: 'conditional', stance: 'conditional', conditionality: 'conditional', evidenceType: 'unclear', confidence: 0.7, needsHumanReview: false },
    { id: 'b', cluster: 'insufficient', stance: 'insufficient', conditionality: 'unclear', evidenceType: 'unclear', confidence: 0.2, needsHumanReview: true },
  ]);
  const result = parseClusterResponse(content, items);
  assert.equal(result.ok, true);
  assert.equal(result.items[0].stance, 'neutral');
  assert.equal(result.items[1].stance, 'uncertain');
});

test('applyClusterOverrides only changes validated labels and preserves evidence fields', () => {
  const clustered = [{ id: 'a', cluster: 'conditional', stanceScore: 0.4, conditionalSide: 'support', evidenceCompleteness: 0.8 }];
  const out = applyClusterOverrides(clustered, [{ id: 'a', cluster: 'support' }]);
  assert.equal(out[0].cluster, 'support');
  assert.equal(out[0].conditionalSide, null);
  assert.equal(out[0].evidenceCompleteness, 0.8);
  assert.equal(out[0].aiClustered, true);
});

test('AI 改成条件成立时沿用确定性方向，不把明确立场推到中线', () => {
  const base = cluster([{ id: 'directional', excerpt: '应该优先就业，没有足够数据证明读研更好', authorityLevel: 3 }]);
  assert.equal(base[0].cluster, 'support');
  const out = applyClusterOverrides(base, [{ id: 'directional', cluster: 'conditional' }]);
  assert.equal(out[0].cluster, 'conditional');
  assert.equal(out[0].conditionalSide, 'support');
});

test('AI 覆盖后 stanceScore 与最终簇方向一致', () => {
  const base = cluster([
    { id: 'support', excerpt: '应该尽早行动', authorityLevel: 3 },
    { id: 'insufficient', excerpt: '暂时没有足够数据下结论', authorityLevel: 3 },
  ]);
  const out = applyClusterOverrides(base, [
    { id: 'support', cluster: 'oppose', stance: 'oppose' },
    { id: 'insufficient', cluster: 'support', stance: 'support' },
  ]);
  assert.ok(out[0].stanceScore < 0);
  assert.equal(out[0].stance, 'oppose');
  assert.ok(out[1].stanceScore > 0);
  assert.equal(out[1].stance, 'support');
});

test('条件簇强制保持条件字段，并与 AI 的中性方向一致', () => {
  const base = cluster([{ id: 'conditional', excerpt: '如果时间充足，可以考虑这个方案', authorityLevel: 3 }]);
  const out = applyClusterOverrides(base, [{
    id: 'conditional', cluster: 'conditional', stance: 'neutral', conditionality: 'unconditional',
  }]);
  assert.equal(out[0].conditionality, 'conditional');
  assert.equal(out[0].conditionalSide, 'neutral');
  assert.equal(out[0].stanceScore, 0);
});

test('非法 AI 簇标签不会污染规则结果', () => {
  const base = cluster([{ id: 'safe', excerpt: '应该谨慎行动', authorityLevel: 3 }]);
  const out = applyClusterOverrides(base, [{ id: 'safe', cluster: 'made-up-cluster', stance: 'oppose' }]);
  assert.equal(out[0].cluster, base[0].cluster);
  assert.equal(out[0].aiClustered, undefined);
});

test('只把低置信度或复杂表达送入批量 AI，不消耗高置信度规则结果的配额', () => {
  const candidates = selectAiClusterCandidates([
    { id: 'clear', excerpt: '明确支持', cluster: 'support', confidence: 0.92, needsHumanReview: false, conditionality: 'unconditional' },
    { id: 'mixed', excerpt: '如果这样就支持，反过来则反对', cluster: 'conditional', confidence: 0.8, needsHumanReview: false, conditionalSide: 'mixed', conditionality: 'conditional' },
    { id: 'uncertain', excerpt: '暂时无法判断', cluster: 'insufficient', confidence: 0, needsHumanReview: true, conditionality: 'unclear' },
  ]);
  assert.deepEqual(candidates.map((item) => item.id), ['uncertain', 'mixed']);
});
