import assert from 'node:assert/strict';
import test from 'node:test';
import { cluster } from '../../src/cluster.js';
import {
  argumentBucket,
  computeSummary,
  stanceBucket,
  stanceCenterLabel,
} from '../../src/spectrum.js';

test('立场计数不把条件成立算进中立，重心与立场计数同源', () => {
  const items = cluster([
    { id: 'c1', title: 't', excerpt: '如果收入稳定，应该尽早开始。', author: '甲', authorityLevel: 3, voteupCount: 10, commentCount: 1, relevanceScore: 0.8, fusedScore: 0.8, featuredComment: '', url: 'https://www.zhihu.com/question/1' },
    { id: 'c2', title: 't', excerpt: '取决于行业，前提成立才值得。', author: '乙', authorityLevel: 3, voteupCount: 8, commentCount: 1, relevanceScore: 0.7, fusedScore: 0.7, featuredComment: '', url: 'https://www.zhihu.com/question/2' },
    { id: 'i1', title: 't', excerpt: '缺乏数据暂无定论，需要更多样本。', author: '丙', authorityLevel: 2, voteupCount: 2, commentCount: 0, relevanceScore: 0.4, fusedScore: 0.4, featuredComment: '', url: 'https://www.zhihu.com/question/3' },
  ]);
  const summary = computeSummary(items);
  assert.equal(summary.counts.support + summary.counts.oppose + summary.counts.conditional + summary.counts.insufficient, items.length);
  assert.equal(summary.stanceCounts.support + summary.stanceCounts.neutral + summary.stanceCounts.oppose, items.length);
  assert.equal(summary.argumentCounts.direct + summary.argumentCounts.conditional + summary.argumentCounts.insufficient, items.length);
  assert.equal(summary.centerLabel, stanceCenterLabel(summary.stanceCounts));
  assert.notEqual(summary.centerLabel.includes('反对') && summary.stanceCounts.oppose === 0 && summary.stanceCounts.support === 0, true);
  if (summary.stanceCounts.support === 0 && summary.stanceCounts.oppose === 0) {
    assert.equal(summary.centerLabel, '整体中立');
  }
});

test('条件成立条目按立场侧计入支持或反对，论证性质仍是条件成立', () => {
  const supportConditional = {
    cluster: 'conditional',
    stance: 'support',
    conditionalSide: 'support',
    conditionality: 'conditional',
    evidenceType: 'personal_experience',
    stanceScore: 0.6,
    fusedScore: 0.5,
    evidenceCompleteness: 0.7,
    heatScore: 0.4,
    credibility: 0.6,
  };
  assert.equal(stanceBucket(supportConditional), 'support');
  assert.equal(argumentBucket(supportConditional), 'conditional');
  const summary = computeSummary([supportConditional]);
  assert.equal(summary.stanceCounts.support, 1);
  assert.equal(summary.stanceCounts.neutral, 0);
  assert.equal(summary.argumentCounts.conditional, 1);
  assert.equal(summary.centerLabel, '整体偏向支持');
});
