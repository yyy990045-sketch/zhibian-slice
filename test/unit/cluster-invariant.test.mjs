// cluster-invariant.test.mjs — 聚类决策不变量（US-16）
// 目的：把「确定性规则分类」的核心不变量固化为回归门禁，防止后续改动破坏单调性与安全性。
// 运行：node --test test/unit/cluster-invariant.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyText, CLUSTER_META, cluster } from '../../src/cluster.js';
import { MOCK_TOPICS } from '../../src/mockData.js';
import { fuse } from '../../src/fusion.js';
import { computeLayout, computeTopicVisualScale } from '../../src/spectrum.js';

const CLUSTERS = ['support', 'oppose', 'conditional', 'insufficient'];

// 不变量 1：输出永远落在四簇之一（闭包）
test('分类输出永远落在四簇之一', () => {
  for (const t of ['应该支持', '不该这样', '看情况吧', '完全没有依据', '', '   ', '123']) {
    const r = classifyText(t);
    assert.ok(CLUSTERS.includes(r.cluster), `文本「${t}」输出 ${r.cluster} 不在四簇`);
  }
});

// 不变量 2：stanceScore 有界（数学安全）
test('stanceScore 始终在 [-1, 1] 区间', () => {
  for (let i = 0; i < 200; i++) {
    const t = ['应该', '不该', '反对', '必须', '前提', '如果', '缺乏数据'].sort(() => Math.random() - 0.5).slice(0, 4).join('');
    const r = classifyText(t);
    assert.ok(r.stanceScore >= -1 && r.stanceScore <= 1, `score ${r.stanceScore} 越界`);
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence ${r.confidence} 越界`);
  }
});

// 不变量 3：支持词与反对词抵消后由净立场决定，不会出现「支持词多却判反对」
test('支持词多于反对词时不会判为反对', () => {
  const r = classifyText('应该支持，应该赞同，应该坚持，但有点风险');
  assert.notEqual(r.cluster, 'oppose', '支持词占优不应判反对');
});

// 不变量 4：否定前缀翻转支持→反对（否定处理有效性）
test('否定前缀正确翻转立场', () => {
  const plain = classifyText('应该提前消费');
  const negated = classifyText('不应该提前消费');
  assert.equal(plain.cluster, 'support');
  assert.equal(negated.cluster, 'oppose');
});

// 不变量 5：空/纯空白文本安全返回 insufficient（不抛错）
test('空文本安全返回 insufficient', () => {
  assert.equal(classifyText('').cluster, 'insufficient');
  assert.equal(classifyText('   ').cluster, 'insufficient');
  assert.equal(classifyText(null).cluster, 'insufficient');
  assert.equal(classifyText(undefined).cluster, 'insufficient');
});

// 不变量 6：cluster() 批量不破坏 item 结构（字段保留 + 四簇字段注入）
test('cluster() 保留原字段并注入四簇字段', () => {
  const items = [{ id: 'a', excerpt: '应该攒钱', author: '甲', url: 'https://www.zhihu.com/question/1', authorityLevel: 3, voteupCount: 100 }];
  const out = cluster(items);
  assert.equal(out[0].id, 'a');
  assert.ok(CLUSTERS.includes(out[0].cluster));
  assert.equal(typeof out[0].confidence, 'number');
  assert.equal(typeof out[0].credibility, 'number');
});

test('观点分类拆成三维字段，同时保留原文、来源与分类依据', () => {
  const [item] = cluster([{
    id: 'three-dim',
    excerpt: '我支持尽早攒钱，但前提是收入稳定，根据 2025 年调查，样本仍有限。',
    author: '甲',
    publishTime: '2025-01-01',
    url: 'https://www.zhihu.com/question/2',
    authorityLevel: 4,
  }]);
  assert.equal(item.cluster, 'conditional');
  assert.equal(item.stance, 'support');
  assert.equal(item.conditionality, 'conditional');
  assert.equal(item.evidenceType, 'data');
  assert.match(item.condition, /前提/);
  assert.equal(item.classificationMethod, 'rules');
  assert.equal(item.sourceId, 'three-dim');
  assert.deepEqual(item.sourceRef, {
    id: 'three-dim', author: '甲', url: 'https://www.zhihu.com/question/2', publishTime: '2025-01-01',
  });
  assert.equal(item.originalText, item.excerpt);
  assert.ok(item.evidenceExcerpt);
});

test('无法判断的文本不会被伪装成确定立场', () => {
  const result = classifyText('这个问题还需要更多研究，暂时没有定论');
  assert.equal(result.stance, 'uncertain');
  assert.equal(result.evidenceType, 'lacking_evidence');
  assert.equal(result.needsHumanReview, true);
});

// 不变量 7：CLUSTER_META 覆盖全部四簇（UI 依赖）
test('CLUSTER_META 覆盖全部四簇', () => {
  for (const c of CLUSTERS) assert.ok(CLUSTER_META[c], `缺少 ${c} 的元数据`);
});

// ---------- 「条件成立」作为立场修饰：方向不变量 ----------
// 背景：条件簇需要保留最终方向，不能让 conditionalSide 固定为 neutral。

// 不变量 8：带前提的支持 → conditional + support 侧
test('带前提的支持判为 conditional 且落在支持侧', () => {
  const r = classifyText('应该尽早开始，但这取决于你的现金流，如果收入不稳定就先留应急金');
  assert.equal(r.cluster, 'conditional');
  assert.ok(r.stanceScore > 0, `stanceScore 应为正，实际 ${r.stanceScore}`);
  const [it] = cluster([{ id: 'c-s', excerpt: '应该尽早开始，但这取决于你的现金流，如果收入不稳定就先留应急金' }]);
  assert.equal(it.conditionalSide, 'support');
});

// 不变量 9：带前提的反对 → conditional + oppose 侧
test('带前提的反对判为 conditional 且落在反对侧', () => {
  const r = classifyText('不应该盲目早存，这取决于你的阶段，如果刚毕业风险更大');
  assert.equal(r.cluster, 'conditional');
  assert.ok(r.stanceScore < 0, `stanceScore 应为负，实际 ${r.stanceScore}`);
  const [it] = cluster([{ id: 'c-o', excerpt: '不应该盲目早存，这取决于你的阶段，如果刚毕业风险更大' }]);
  assert.equal(it.conditionalSide, 'oppose');
});

// 不变量 10：方向不明的条件 → conditional + neutral
test('方向不明的条件判为 conditional 且落在中线', () => {
  const r = classifyText('看情况取决于前提');
  assert.equal(r.cluster, 'conditional');
  assert.equal(r.stanceScore, 0);
  const [it] = cluster([{ id: 'c-n', excerpt: '看情况取决于前提' }]);
  assert.equal(it.conditionalSide, 'neutral');
});

// 不变量 11：双向条件不得被压缩成单侧观点
test('双向条件判为 conditional 且标记 mixed', () => {
  const text = '如果指纯执行，风险很大；如果指解决问题的工程师，价值在上升';
  const r = classifyText(text);
  assert.equal(r.cluster, 'conditional');
  const [it] = cluster([{ id: 'c-m', excerpt: text }]);
  assert.equal(it.conditionalSide, 'mixed');
  assert.ok(Math.abs(it.stanceScore) > 0, '应保留分支信号供审计');
});

// 不变量 12：conditionalSide 与 stanceScore 符号严格一致（不允许出现「正向却判反对侧」）
test('conditionalSide 与 stanceScore 符号严格一致', () => {
  const texts = [
    '应该支持，但看情况取决于预算',
    '不该这么做，但看情况取决于场景',
    '看情况取决于前提',
    '如果条件允许，建议先工作两年再读研',
    '如果指纯执行，风险很大；如果指解决问题，价值在上升',
  ];
  for (const t of texts) {
    const [it] = cluster([{ id: 'x', excerpt: t }]);
    if (it.cluster !== 'conditional') continue;
    if (it.conditionalSide === 'mixed') continue;
    const s = it.stanceScore;
    const expect = s > 0.05 ? 'support' : s < -0.05 ? 'oppose' : 'neutral';
    assert.equal(it.conditionalSide, expect, `文本「${t}」stanceScore=${s} 但 side=${it.conditionalSide}`);
  }
});

// 不变量 13：非 conditional 簇不带 conditionalSide（避免下游误读）
test('非条件成立簇的 conditionalSide 恒为 null', () => {
  for (const t of ['强烈建议越早越好', '风险很大应该警惕', '缺乏数据暂无定论']) {
    const [it] = cluster([{ id: 'y', excerpt: t }]);
    assert.notEqual(it.cluster, 'conditional');
    assert.equal(it.conditionalSide, null);
  }
});

// 不变量 14：演示语料必须覆盖带方向条件与双向条件条目；反对侧由独立合成用例覆盖
// 目的：防止 conditionalSide 的方向分支再次退化为无人执行的死代码
test('演示语料覆盖带方向的条件成立条目', () => {
  const sides = new Set();
  for (const topic of MOCK_TOPICS) {
    for (const it of cluster(fuse(topic.items))) {
      if (it.cluster === 'conditional') sides.add(it.conditionalSide);
    }
  }
  assert.ok(sides.has('support'), '演示语料缺少「带前提的支持」样本');
  assert.ok(sides.has('mixed'), '演示语料缺少「双向条件」样本');
});

// ---------- 双向条件的反向不变量：不许过度触发 ----------
// 背景：双向判定一旦过宽，会把「带前提的支持」误压成 mixed，等于删掉了正确方向。
// 以下两条是实测踩过的坑，必须固化。

// 不变量 15：对比标记后紧跟条件词时，引出的是「前提」而非对立主张
test('「但前提」不被误判为双向条件', () => {
  const text = '越早越好，但前提是你有稳定收入';
  const [it] = cluster([{ id: 'p1', excerpt: text }]);
  assert.equal(it.cluster, 'conditional');
  assert.notEqual(it.conditionalSide, 'mixed', '「但前提」是给结论补条件，不是两边对立');
  assert.equal(it.conditionalSide, 'support');
});

// 不变量 16：单字转折词须位于分句开头，「视情况而定」里的「而」不算转折
// 反例来自演示语料 s3 的热评「没有万能公式，视情况而定」，曾把 s3 误判成双向。
test('固定搭配中的单字转折词不触发双向判定', () => {
  const text = '取决于收入和城市，先留足应急金更务实，没有万能公式，视情况而定';
  const [it] = cluster([{ id: 'p2', excerpt: text }]);
  assert.equal(it.cluster, 'conditional');
  assert.notEqual(it.conditionalSide, 'mixed', '「视情况而定」的「而」不是转折');
});

// 不变量 17：mixed 的落位不参考 stanceScore
// 双向句上的 stanceScore 来自全局词频，无法归属到分支，方向不可靠
// （a8 的「风险」属于第一个分支，语义上却是支持侧，全局计数会算成反对）。
// 保留任何比例都等于保留一部分错误方向，故布局必须完全不读它。
test('双向条件的落位不随 stanceScore 偏移', () => {
  const make = (excerpt) => cluster([{
    id: 'm-' + excerpt.length,
    excerpt,
    authorityLevel: 3,
    voteupCount: 5000,
  }])[0];
  const item = make('如果指纯执行，风险很大；如果指解决问题的工程师，价值在上升，关键看能力结构');
  assert.equal(item.conditionalSide, 'mixed');
  assert.ok(item.stanceScore < 0, `该样本 stanceScore 为负，实际 ${item.stanceScore}`);
  // 即使 stanceScore 明显偏负，落位也必须留在分水岭带内（|x| ≤ 0.16）
  const [node] = computeLayout([item]);
  assert.ok(Math.abs(node.x) <= 0.16,
    `mixed 落位应留在分水岭带内，实际 x=${node.x}（stanceScore=${item.stanceScore}）`);
});

// 不变量 20：簇颜色只有 CLUSTER_META 一份真相源
// 背景：分享图卡曾维护第二份簇配色，且与海图完全对调（图卡里支持=绿、条件成立=蓝，
// 海图里恰好相反），导致分享出去的图与用户刚看到的海图语义相反。
// 颜色在本项目里承载数据含义，出现第二份就等于埋下静默漂移，故在测试层禁止。
test('簇颜色不得在渲染层硬编码', () => {
  const files = ['../../src/app.js', '../../index.html'];
  const forbidden = Object.values(CLUSTER_META).map((m) => m.color.toUpperCase());
  for (const rel of files) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8').toUpperCase();
    for (const color of forbidden) {
      assert.ok(
        !src.includes(color),
        `${rel} 写死了簇颜色 ${color}；应引用 CLUSTER_META 或 CSS 变量，避免第二份真相`,
      );
    }
  }
});

// 不变量 18：热度视觉缩放按话题自适应，但不改写原始 heatScore
test('话题内热度缩放保留相对差异且避免极端尺寸', () => {
  const items = cluster([
    { id: 'heat-low', excerpt: '应该支持', authorityLevel: 2, voteupCount: 1 },
    { id: 'heat-mid', excerpt: '应该支持', authorityLevel: 2, voteupCount: 300 },
    { id: 'heat-high', excerpt: '应该支持', authorityLevel: 2, voteupCount: 900000 },
  ]);
  const scale = computeTopicVisualScale(items);
  const values = items.map((it) => scale.heatById.get(it.id));
  assert.ok(values[0] < values[1] && values[1] < values[2], `视觉热度未保持排序: ${values}`);
  assert.ok(values.every((value) => value >= 0.22 && value <= 0.88), `视觉热度越界: ${values}`);
  assert.ok(items.every((it) => it.heatScore >= 0 && it.heatScore <= 1), '原始热度字段被改写');
});

// 不变量 19：灯塔必须同时满足话题内高权威与高证据，且不能降低安全下限
test('灯塔门槛自适应但不低于权威度 4 与扎实度 0.6', () => {
  const items = cluster([
    { id: 'auth-1', excerpt: '应该支持', authorityLevel: 4, voteupCount: 100 },
    { id: 'auth-2', excerpt: '应该支持，研究数据显示趋势明显', authorityLevel: 5, voteupCount: 200 },
    { id: 'auth-3', excerpt: '应该支持', authorityLevel: 5, voteupCount: 300 },
  ]);
  const scale = computeTopicVisualScale(items);
  assert.ok(scale.authorityFloor >= 4);
  assert.ok(scale.evidenceFloor >= 0.6);
  const layout = computeLayout(items);
  assert.ok(layout.every((node) => node.isLighthouse === (node.item.authorityLevel >= scale.authorityFloor
    && node.item.evidenceCompleteness >= scale.evidenceFloor)));
});
