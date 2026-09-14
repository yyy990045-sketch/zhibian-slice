// 核心纯函数单测（node:test 风格，供覆盖率门禁统计；断言与 _smoke_*.mjs 互补）
// 运行：node --experimental-test-coverage --test test/unit/  （阈值检查见 run-coverage.sh）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyText } from '../../src/cluster.js';
import { fuse, rrfFuse } from '../../src/fusion.js';
import { generateChallenges } from '../../src/challenge.js';
import { sanitizeSourceUrl, isUsableSource } from '../../src/source.js';
import { publicMessage, ERROR_CODES } from '../../src/errors.js';
import { resolveFinalRisk, validateEscalation, decisionDigest } from '../../src/guard.js';
import { buildRiskRecommendations, concentrationSignal, detectRisks, fieldGapSignal, overclaimSignal, resolveRiskLevel } from '../../src/risk.js';

test('cluster.classifyText 四簇判定与置信度', () => {
  assert.equal(classifyText('强烈建议越早越好').cluster, 'support');
  assert.equal(classifyText('风险很大应该警惕').cluster, 'oppose');
  assert.equal(classifyText('看情况取决于前提').cluster, 'conditional');
  assert.equal(classifyText('缺乏数据暂无定论').cluster, 'insufficient');
  assert.ok(classifyText('完全无关文本').confidence === 0);
});

test('fusion.fuse 加权排序与去重', () => {
  const out = fuse([
    { id: 'same', author: '甲', title: 'AI 会不会取代程序员（完整版）', relevanceScore: 0.9, voteupCount: 10, commentCount: 1, authorityLevel: 3, publishTime: '' },
    { id: 'same', author: '甲', title: 'AI 会不会取代程序员（转载）', relevanceScore: 0.1, voteupCount: 0, commentCount: 0, authorityLevel: 1, publishTime: '' },
  ]);
  assert.equal(out.length, 1, '同一稳定 ID 重复被去重');
  assert.equal(typeof out[0].fusedScore, 'number');
});

test('fusion.fuse 不删除相似标题但身份和观点不同的回答', () => {
  const out = fuse([
    { id: 'support', author: '甲', title: 'AI 会不会取代程序员（完整版）', excerpt: '支持，会提高效率。', cluster: 'support', relevanceScore: 0.9, voteupCount: 10, commentCount: 1, authorityLevel: 3, publishTime: '' },
    { id: 'oppose', author: '甲', title: 'AI 会不会取代程序员（转载）', excerpt: '反对，不会全面取代。', cluster: 'oppose', relevanceScore: 0.8, voteupCount: 9, commentCount: 1, authorityLevel: 3, publishTime: '' },
  ]);
  assert.deepEqual(out.map((item) => item.id).sort(), ['oppose', 'support']);
});

test('fusion.rrfFuse 多路去重与通道标记', () => {
  const it = { id: 'a', author: '甲', title: 't', authorityLevel: 1, voteupCount: 1 };
  const out = rrfFuse([{ source: 'search', items: [it] }, { source: 'hot', items: [it] }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].channels, ['hot', 'search']);
});

test('challenge.generateChallenges source-gated', () => {
  const clusters = {
    support: { items: [{ id: 's', author: '甲', url: 'https://www.zhihu.com/question/1', excerpt: '支持理由', authorityLevel: 3, voteupCount: 5 }] },
    oppose: { items: [{ id: 'o', author: '乙', url: '', excerpt: '反对理由', authorityLevel: 3, voteupCount: 5 }] },
    conditional: { items: [] }, insufficient: { items: [] },
  };
  const ch = generateChallenges({ userStance: '支持', clusters, summary: { total: 1 } });
  assert.ok(ch.every((c) => c.sourceRef && sanitizeSourceUrl(c.sourceRef.url)), '每条挑战都绑定可用来源');
});

test('challenge 不同方向 / 成立条件 / 证据边界分支', () => {
  const base = { authorityLevel: 3, voteupCount: 5, excerpt: '这是一个足够长的摘要文本用于挑战生成', url: 'https://www.zhihu.com/question/9' };
  // 条件簇存在 → missing_condition
  const withCond = generateChallenges({
    userStance: '支持',
    clusters: {
      support: { items: [{ ...base, id: 's1', author: '甲' }] },
      oppose: { items: [{ ...base, id: 'o1', author: '乙', excerpt: '反对的详细理由文本内容' }] },
      conditional: { items: [{ ...base, id: 'c1', author: '丙' }] },
      insufficient: { items: [] },
    },
    summary: { total: 3 },
  });
  assert.ok(withCond.some((c) => c.type === 'missing_condition'), '条件簇存在时产出遗漏条件挑战');
  // 证据不足占比高 → evidence_gap
  const withGap = generateChallenges({
    userStance: '中立',
    clusters: {
      support: { items: [] }, oppose: { items: [] }, conditional: { items: [] },
      insufficient: { items: [{ ...base, id: 'i1', author: '丁', excerpt: '缺乏数据暂无定论' }] },
    },
    summary: { total: 1 },
  });
  assert.ok(withGap.some((c) => c.type === 'evidence_gap'), '证据不足占比高时产出证据不足挑战');
  // 反对侧权威更高也不能推出用户发生逻辑跳跃。
  const withoutLeap = generateChallenges({
    userStance: '支持',
    clusters: {
      support: { items: [{ ...base, id: 's2', author: '甲', authorityLevel: 2, voteupCount: 5 }] },
      oppose: { items: [{ ...base, id: 'o2', author: '乙', authorityLevel: 5, voteupCount: 999 }] },
      conditional: { items: [] }, insufficient: { items: [] },
    },
    summary: { total: 2 },
  });
  assert.ok(withoutLeap.every((c) => c.type !== 'logic_leap'), '来源热度或权威度不再推导逻辑跳跃');
  assert.ok(withoutLeap.every((c) => !c.text.includes('前提未被强证据支撑')), '挑战文案不越过来源能支持的语义边界');
  assert.ok(withoutLeap.some((c) => c.text.includes('值得核对的理由')), '不同方向挑战使用来源可支持的克制措辞');
});

test('source.sanitizeSourceUrl 清洗与门禁', () => {
  assert.equal(sanitizeSourceUrl('http://127.0.0.1/x'), '');
  assert.equal(sanitizeSourceUrl('https://www.zhihu.com/question/42/answer/7'), 'https://www.zhihu.com/question/42');
  assert.equal(isUsableSource({ author: '', url: 'https://www.zhihu.com/question/1' }), false);
  assert.equal(sanitizeSourceUrl('https://www.zhihu.com/question/123abc'), '');
  assert.equal(sanitizeSourceUrl('https://www.zhihu.com/question/123-foo'), '');
});

test('errors.publicMessage 单出口', () => {
  assert.equal(publicMessage(ERROR_CODES.NOT_CONFIGURED).length > 0, true);
  assert.equal(publicMessage('unknown'), '暂时无法获取数据。');
});

test('guard 单调与契约', () => {
  assert.equal(resolveFinalRisk({ hardFloor: 'high', semanticBaseline: 'low' }), 'high');
  assert.equal(resolveFinalRisk({ hardFloor: 'low', validatedEscalation: 'critical' }), 'critical');
  assert.equal(validateEscalation('短'), null);
  assert.equal(decisionDigest({ a: 1 }), decisionDigest({ a: 1 }));
});

test('风险建议只绑定可核验知乎来源', () => {
  const items = [
    { id: 'bad', author: '甲', url: 'https://evil.example/item', excerpt: '一定会成功', publishTime: '2026-01-01' },
    { id: 'good', author: '乙', url: 'https://www.zhihu.com/question/1', excerpt: '一定会成功', publishTime: '2026-01-01' },
  ];
  const signals = detectRisks(items, items.map((item) => item.excerpt));
  const recommendations = buildRiskRecommendations(signals, items);
  assert.ok(recommendations.length > 0);
  assert.ok(recommendations.every((item) => !item.sourceRef || item.sourceRef.url.startsWith('https://www.zhihu.com/')));
});

test('risk.js 覆盖空输入、阈值、排序和建议分支', () => {
  assert.equal(concentrationSignal(null), null);
  assert.equal(concentrationSignal([{ author: '甲' }]), null);
  assert.equal(concentrationSignal([{ author: '' }, { author: '' }, { author: '' }], { minTotal: 3 }), null);
  const balanced = [{ author: '甲' }, { author: '乙' }, { author: '丙' }, { author: '丁' }];
  assert.equal(concentrationSignal(balanced, { threshold: 0.75 }), null);
  const high = concentrationSignal([{ author: '甲' }, { author: '甲' }, { author: '甲' }, { author: '甲' }], { minTotal: 4 });
  assert.equal(high.level, 'high');
  const unknownKey = concentrationSignal([{ category: 'x' }, { category: 'x' }, { category: 'y' }, { category: 'z' }], { key: 'category', minTotal: 4 });
  assert.match(unknownKey.detail, /category/);

  assert.equal(overclaimSignal(''), null);
  assert.equal(overclaimSignal('这是一段普通说明'), null);
  assert.equal(overclaimSignal('必然成功', { absWords: ['必然'], condWords: ['条件'] }).words[0], '必然');
  assert.equal(overclaimSignal('条件满足后必然成功', { absWords: ['必然'], condWords: ['条件'] }), null);

  assert.equal(fieldGapSignal([]), null);
  assert.equal(fieldGapSignal([{ author: '甲', url: 'u', publishTime: 't' }, { author: '乙', url: 'u', publishTime: 't' }]), null);
  const gap = fieldGapSignal([{ author: '', url: '', publishTime: '' }, { author: '甲', url: '', publishTime: 't' }]);
  assert.deepEqual(gap.fields.map((item) => item.key), ['author', 'url', 'publishTime']);

  assert.equal(resolveRiskLevel([]), 'low');
  assert.equal(resolveRiskLevel([{ level: 'medium' }]), 'medium');
  assert.equal(resolveRiskLevel([{ level: 'high' }, { level: 'medium' }]), 'high');
  const usable = [{ id: 'u', author: '甲', url: 'https://www.zhihu.com/question/1' }];
  const recs = buildRiskRecommendations([
    { type: 'concentration', detail: '作者占比 100%' },
    { type: 'field_gap', detail: '作者 50%' },
    { type: 'overclaim', detail: '含必须' },
    { type: 'unknown' },
  ], usable);
  assert.deepEqual(recs.map((item) => item.type), ['risk_concentration', 'risk_field_gap', 'risk_overclaim']);
  assert.equal(buildRiskRecommendations([{ type: 'concentration', detail: 'x' }], [{ id: 'bad', author: '甲', url: 'https://evil.example/x' }]).length, 0);
  assert.equal(buildRiskRecommendations(null, usable).length, 0);
});
