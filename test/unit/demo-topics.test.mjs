import test from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_TOPICS } from '../../src/mockData.js';

test('三个稳定演示话题覆盖比赛增强版的三类场景', () => {
  assert.equal(MOCK_TOPICS.length, 3);
  assert.deepEqual(
    MOCK_TOPICS.map((topic) => topic.scenario?.id).sort(),
    ['ai-society', 'career-choice', 'learning-growth'],
  );
  for (const topic of MOCK_TOPICS) {
    assert.equal(topic.demo, true);
    assert.ok(topic.query);
    assert.ok(topic.items.length >= 6);
    assert.ok(topic.items.every((item) => item.url.startsWith('https://www.zhihu.com/')));
  }
});

test('演示来源链接指向对应主题的真实知乎问题页，正文仍明确属于演示数据', () => {
  const expectedQuestionIds = {
    'save-money': '434965795',
    'ai-replace-dev': '1972252087044796716',
    'grad-vs-job': '405883269',
  };
  for (const topic of MOCK_TOPICS) {
    const questionId = expectedQuestionIds[topic.id];
    assert.ok(questionId);
    assert.ok(topic.items.every((item) => item.url === `https://www.zhihu.com/question/${questionId}`));
  }
});
