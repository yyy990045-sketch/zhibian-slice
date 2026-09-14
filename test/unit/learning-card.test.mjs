import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLearningCard } from '../../src/learning-card.js';

const base = {
  author: '作者',
  url: 'https://www.zhihu.com/question/42/answer/7',
  authorityLevel: 4,
  voteupCount: 100,
  evidenceCompleteness: 0.8,
  confidence: 0.7,
  classificationMethod: 'rules',
};

test('学习卡选择条件来源，并保留 source ID、URL、原文片段和方法', () => {
  const result = buildLearningCard([
    { ...base, id: 'support', cluster: 'support', excerpt: '应该做这件事。' },
    { ...base, id: 'conditional', cluster: 'conditional', excerpt: '如果收入稳定，就应该做。', condition: '如果收入稳定', evidenceType: 'personal_experience', evidenceExcerpt: '如果收入稳定，就应该做。' },
  ], { userStance: 'support' });
  assert.equal(result.ok, true);
  assert.equal(result.source.id, 'conditional');
  assert.equal(result.source.sourceId, 'conditional');
  assert.equal(result.source.url, 'https://www.zhihu.com/question/42');
  assert.equal(result.source.excerpt, '如果收入稳定，就应该做。');
  assert.equal(result.condition, '如果收入稳定');
  assert.equal(result.evidenceTypeLabel, '个人经验');
  assert.equal(result.source.classificationMethod, 'rules');
});

test('没有可用来源时不生成学习卡或挑战依据', () => {
  const result = buildLearningCard([{ id: 'no-source', cluster: 'support', excerpt: '应该做。', url: '' }]);
  assert.equal(result.ok, false);
  assert.equal(result.source, null);
  assert.equal(result.needsHumanReview, true);
});

test('AI 提供的证据片段不在原文中时回退到原文并标记复核', () => {
  const result = buildLearningCard([{
    ...base,
    id: 'ai-source',
    cluster: 'oppose',
    originalText: '原文只说需要看具体场景。',
    excerpt: '原文只说需要看具体场景。',
    evidenceExcerpt: '模型凭空补出的结论。',
  }], { userStance: 'support' });
  assert.equal(result.source.excerpt, '原文只说需要看具体场景。');
  assert.equal(result.source.evidenceExcerptVerified, false);
  assert.equal(result.source.needsHumanReview, true);
  assert.equal(result.needsHumanReview, true);
});
