import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResearchState, snapshotResearchState, RESEARCH_STORAGE_TTL_MS } from '../../src/research-storage.js';

function source(id = 'source-1') {
  return { id, title: '标题', excerpt: '应该支持', originalText: '应该支持', author: '作者', url: 'https://www.zhihu.com/question/42', stance: 'support', conditionality: 'unconditional', evidenceType: 'personal_experience', confidence: 0.8 };
}

test('research storage snapshot round-trips a completed local run without credentials', () => {
  const now = 1_700_000_000_000;
  const run = {
    schema: 'zhibian-research-run-v1',
    runId: 'topic-1', mode: 'topic', topic: '测试问题', isDemo: true, status: 'ready', createdAt: new Date(now).toISOString(),
    initialJudgment: { stance: 'oppose', reason: '先看来源' },
    evidencePack: {
      sources: [{ id: 'source-1', title: '标题', author: '作者', url: 'https://www.zhihu.com/question/42', excerpt: '应该支持', sourceQuality: { usable: true, authorityLevel: 3, evidenceExcerptVerified: true } }],
      claims: [{ sourceId: 'source-1', proposition: '应该支持', stance: 'support', conditionality: 'unconditional', evidenceType: 'personal_experience', condition: '', evidenceExcerpt: '应该支持', evidenceExcerptVerified: true, confidence: 0.8, classificationMethod: 'rules', needsHumanReview: false, cluster: 'support' }],
      gaps: [], limitations: [], counts: { totalItems: 1, sourceCount: 1, claimCount: 1, gapCount: 0, humanReviewCount: 0 },
    },
  };
  const snapshot = snapshotResearchState({
    researchRun: run,
    items: [source()],
    mode: 'topic', isDemo: true, userStance: 'oppose', initialReason: '先看来源',
    openedSourceIds: new Set(['source-1']), secondJudgment: { stance: 'neutral', reason: '保留中立' },
  }, now);
  const parsed = parseResearchState(JSON.stringify(snapshot), now + 1000);
  assert.equal(parsed.researchRun.runId, 'topic-1');
  assert.deepEqual(parsed.openedSourceIds, ['source-1']);
  assert.deepEqual(parsed.secondJudgment, { stance: 'neutral', reason: '保留中立' });
  assert.equal(snapshotResearchState({
    researchRun: run,
    items: [source()],
    mode: 'favorites', isDemo: false, userStance: 'oppose', initialReason: '个人收藏夹内容不得自动保存',
    openedSourceIds: new Set(['source-1']), secondJudgment: null,
  }, now), null);
});

test('research storage rejects expired, malformed, and invalid runs', () => {
  assert.equal(parseResearchState('{bad json}'), null);
  assert.equal(parseResearchState({ version: 1, savedAt: 1, items: [], openedSourceIds: [], userStance: 'support', researchRun: {} }, RESEARCH_STORAGE_TTL_MS + 2), null);
});
