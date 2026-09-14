import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvidencePack,
  createResearchRun,
  updateInitialJudgment,
  validateResearchRun,
} from '../../src/research-run.js';

const source = (overrides = {}) => ({
  id: 'source-1',
  title: '一个可核验回答',
  author: '作者 A',
  url: 'https://www.zhihu.com/question/42/answer/7',
  excerpt: '如果收入稳定，就应该做。',
  originalText: '如果收入稳定，就应该做。',
  evidenceExcerpt: '如果收入稳定，就应该做。',
  cluster: 'conditional',
  stance: 'support',
  conditionality: 'conditional',
  condition: '如果收入稳定',
  evidenceType: 'personal_experience',
  confidence: 0.75,
  classificationMethod: 'rules',
  needsHumanReview: false,
  ...overrides,
});

test('证据包只收录可核验来源，无来源条目进入缺口', () => {
  const pack = buildEvidencePack([
    source(),
    source({ id: 'missing-url', url: '' }),
    source({ id: 'missing-author', author: '' }),
  ]);

  assert.deepEqual(pack.sources.map((item) => item.id), ['source-1']);
  assert.deepEqual(pack.claims.map((item) => item.sourceId), ['source-1']);
  assert.deepEqual(pack.claims[0], {
    sourceId: 'source-1',
    proposition: '如果收入稳定，就应该做。',
    stance: 'support',
    conditionality: 'conditional',
    evidenceType: 'personal_experience',
    condition: '如果收入稳定',
    evidenceExcerpt: '如果收入稳定，就应该做。',
    evidenceExcerptVerified: true,
    confidence: 0.75,
    classificationMethod: 'rules',
    needsHumanReview: false,
    cluster: 'conditional',
  });
  assert.deepEqual(pack.gaps, [
    { sourceId: 'missing-url', reason: '来源 URL 不可用', missing: ['url'] },
    { sourceId: 'missing-author', reason: '来源作者不可用', missing: ['author'] },
  ]);
  assert.deepEqual(pack.counts, { totalItems: 3, sourceCount: 1, claimCount: 1, gapCount: 2, humanReviewCount: 0 });
});

test('研究运行保留首次判断与证据状态，并能通过契约校验', () => {
  const run = createResearchRun({
    runId: 'run-20260907-1',
    mode: 'topic',
    topic: '考研和直接就业，哪个更值得',
    isDemo: true,
    createdAt: '2026-09-07T08:00:00.000Z',
    initialJudgment: { stance: 'support', reason: '我更倾向先就业。' },
    items: [source({ needsHumanReview: true })],
  });

  assert.equal(run.schema, 'zhibian-research-run-v1');
  assert.equal(run.status, 'needs_review');
  assert.deepEqual(run.initialJudgment, { stance: 'support', reason: '我更倾向先就业。' });
  assert.deepEqual(validateResearchRun(run), { ok: true, errors: [] });

  const updated = updateInitialJudgment(run, { stance: 'oppose', reason: '我重新考虑了机会成本。' });
  assert.deepEqual(updated.initialJudgment, { stance: 'oppose', reason: '我重新考虑了机会成本。' });
  assert.deepEqual(run.initialJudgment, { stance: 'support', reason: '我更倾向先就业。' });
  updated.evidencePack.sources[0].title = '后续调用方修改';
  updated.evidencePack.counts.sourceCount = 999;
  assert.equal(run.evidencePack.sources[0].title, '一个可核验回答');
  assert.equal(run.evidencePack.counts.sourceCount, 1);
});

test('运行校验拒绝重复来源 ID和不在证据包内的 claim', () => {
  const run = createResearchRun({
    runId: 'run-invalid',
    topic: '测试话题',
    items: [source(), source({ id: 'source-2' })],
  });
  const invalid = {
    ...run,
    evidencePack: {
      ...run.evidencePack,
      claims: [...run.evidencePack.claims, { ...run.evidencePack.claims[0], sourceId: 'foreign-source' }],
    },
  };

  const result = validateResearchRun(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('claim.sourceId 不在 sources')));

  const duplicate = {
    ...run,
    evidencePack: {
      ...run.evidencePack,
      sources: [run.evidencePack.sources[0], { ...run.evidencePack.sources[1], id: 'source-1' }],
    },
  };
  const duplicateResult = validateResearchRun(duplicate);
  assert.equal(duplicateResult.ok, false);
  assert.ok(duplicateResult.errors.some((error) => error.includes('source.id 重复')));
});
