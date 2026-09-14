import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRepresentativeSources, sourceSelectionSummary } from '../../src/source-selection.js';

const source = (cluster, id, voteupCount, url = `https://www.zhihu.com/question/${id}`) => ({
  cluster, id, title: id, author: '作者', excerpt: '摘要', url, authorityLevel: 3, voteupCount,
});

test('每条阅读航线只选一条代表性来源，并优先选择可打开来源', () => {
  const items = [
    source('support', 'support-no-url', 999, ''),
    source('support', '2', 10),
    source('oppose', '3', 3),
    source('conditional', '4', 2),
    source('insufficient', '5', 1),
  ];
  const primary = selectRepresentativeSources(items);
  assert.deepEqual(primary.map((item) => item.id), ['2', '3', '4', '5']);
  assert.ok(primary.every((item) => item.isPrimarySource && item.selectionReason));
});

test('来源选择不丢全量数据，并能报告展开数量', () => {
  const items = [source('support', '6', 1), source('support', '7', 2), source('oppose', '8', 1)];
  const primary = selectRepresentativeSources(items);
  const summary = sourceSelectionSummary(items, primary);
  assert.equal(primary.length, 2);
  assert.equal(summary.total, 3);
  assert.equal(summary.expandable, 1);
});
