import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateCase,
  summarizeAnnotations,
  validateAnnotation,
  validateHoldoutDraft,
} from '../../scripts/annotate-holdout.mjs';

const draft = {
  meta: { split: 'holdout' },
  cases: [{
    id: 'h-1',
    topic: '话题',
    statement: '这是一段真实回答原文',
    expected: 'unlabeled',
    note: '来源=https://www.zhihu.com/question/1',
    source: { id: 'source-1', url: 'https://www.zhihu.com/question/1' },
  }],
};

test('annotate-holdout 校验草稿但不要求未标注草稿先有标签', () => {
  assert.deepEqual(validateHoldoutDraft(draft), []);
  assert.deepEqual(validateAnnotation('support', '原文明确支持该观点', '人工-1'), []);
  assert.ok(validateAnnotation('unknown', '', '').length >= 3);
});

test('annotate-holdout 只在人工依据非空时生成标签，并保留原文和来源', () => {
  const annotated = annotateCase(draft.cases[0], {
    label: 'conditional',
    rationale: '原文明确给出适用前提，因此标为条件成立。',
    annotator: '人工-1',
    annotatedAt: '2026-09-06T00:00:00.000Z',
  });
  assert.equal(annotated.expected, 'conditional');
  assert.equal(annotated.statement, draft.cases[0].statement);
  assert.deepEqual(annotated.source, draft.cases[0].source);
  assert.equal(annotated.note, draft.cases[0].note);
  assert.equal(annotated.annotation.method, 'independent-human');
  assert.throws(() => annotateCase(draft.cases[0], {
    label: 'support', rationale: ' ', annotator: '人工-1', annotatedAt: 'now',
  }), /依据不能为空/);
});

test('annotate-holdout 汇总未标注状态，不能把草稿误报为完成', () => {
  assert.deepEqual(summarizeAnnotations(draft), {
    total: 1,
    counts: { support: 0, oppose: 0, conditional: 0, insufficient: 0, unlabeled: 1 },
    labeled: false,
  });
  const complete = { ...draft, cases: [annotateCase(draft.cases[0], {
    label: 'support', rationale: '原文直接支持。', annotator: '人工-1', annotatedAt: 'now',
  })] };
  assert.equal(summarizeAnnotations(complete).labeled, true);
  assert.equal(summarizeAnnotations({
    ...draft,
    cases: [{ ...draft.cases[0], expected: 'support', note: draft.cases[0].note }],
  }).labeled, false, '只有 expected 没有人工依据时仍算未标注');
});
