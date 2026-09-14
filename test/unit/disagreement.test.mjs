import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyDisagreement } from '../../src/disagreement.js';

const item = (cluster, id, excerpt) => ({ cluster, id, excerpt, author: '作者', url: `https://www.zhihu.com/question/${id}`, authorityLevel: 4, voteupCount: 100 });

test('关键分歧只引用可核验来源，并保留条件侧', () => {
  const result = buildKeyDisagreement([
    item('support', '11', '支持方向的核心理由'),
    item('oppose', '12', '反对方向的核心理由'),
    item('conditional', '13', '只有满足条件时才成立'),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.refs.length, 3);
  assert.match(result.summary, /真正的分歧/);
  assert.ok(result.refs.every((ref) => ref.url));
});
test('没有可核验来源时不伪造关键分歧', () => {
  const result = buildKeyDisagreement([{ cluster: 'support', id: 'x', excerpt: '支持', author: '作者', url: '' }]);
  assert.equal(result.ok, false);
  assert.equal(result.refs.length, 0);
  assert.equal(result.needsHumanReview, true);
});
