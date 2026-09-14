import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunController } from '../../src/run-lifecycle.js';
import { selectReadingRecommendations } from '../../src/reading-recommendations.js';

const source = (id, cluster, credibility) => ({
  id,
  cluster,
  credibility,
  author: '作者',
  url: `https://www.zhihu.com/question/42/answer/${id}`,
});

test('新研究运行和 Home 会 abort 旧搜索与直答', () => {
  const controller = createRunController();
  const first = controller.beginSearch();
  const answer = controller.beginDirectAnswer();
  const second = controller.beginSearch();
  assert.equal(first.signal.aborted, true);
  assert.equal(answer.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  const invalidated = controller.invalidate();
  assert.equal(second.signal.aborted, true);
  assert.equal(invalidated, second.id + 1);
});

test('支持方优先推荐可核验的反对侧', () => {
  const items = [
    source('support', 'support', 0.99),
    source('oppose', 'oppose', 0.2),
    source('oppose-best', 'oppose', 0.8),
    { ...source('bad', 'oppose', 1), url: 'https://evil.example/question/1' },
  ];
  const result = selectReadingRecommendations(items, 'support');
  assert.deepEqual(result.map((item) => item.id), ['oppose-best', 'oppose']);
});
