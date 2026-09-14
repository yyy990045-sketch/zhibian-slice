// sample-real.js — 真实数据采样脚本（Sprint 1 准备项）
// 用途：把真实知乎搜索/热榜 API 的响应转成供人工标注立场的草稿；默认是 real 回归集，
//       加 --holdout 时生成可合并到独立留出集的草稿。
// 关键诚实边界：真实内容没有「标准答案」立场 → 本脚本输出的 expected 一律为 'unlabeled'，
//       命中率只在人工补标后才有意义；runner 只报告、不做调权（不凭真实噪声提前改词表）。
//
// 用法：
//   node scripts/sample-real.js <raw-api-response.json> [-o out.json] [--topic "争议话题"]
//   node scripts/sample-real.js <raw-api-response.json> --holdout -o holdout-topic.json --topic "争议话题"
// 输入（容忍两种形态）：
//   A. 官方原始包 { Code:0, Data:{ Items:[...] } }（PascalCase 字段）
//   B. 简包 { query|topic: "...", items:[{ ... }] }（camelCase 字段）
// 语句提取优先级：ContentText/Content > excerpt/Summary > Title
import { readFile, writeFile } from 'node:fs/promises';

const [,, rawArg, ...rest] = process.argv;
const outIdx = rest.findIndex((a) => a === '-o');
const outFile = outIdx >= 0 ? rest[outIdx + 1] : null;
const holdout = rest.includes('--holdout');
// 兼容 --topic=xxx 与 --topic xxx 两种写法
let topicArg = rest.find((a) => a.startsWith('--topic='))?.slice('--topic='.length);
if (topicArg === undefined) {
  const ti = rest.findIndex((a) => a === '--topic');
  if (ti >= 0) topicArg = rest[ti + 1];
}
topicArg = topicArg || '';

if (!rawArg) {
  console.error('用法: node scripts/sample-real.js <raw.json> [-o out.json] [--topic "话题"]');
  process.exit(1);
}

const raw = JSON.parse(await readFile(rawArg, 'utf-8'));

function strip(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

function pickStatement(it) {
  // 真实搜索/内容常见字段；ContentText 可能带 <em> 高亮，先剥
  const c = strip(it.ContentText) || strip(it.Content) || strip(it.excerpt) || strip(it.Summary) || strip(it.Title);
  return c;
}

function buildCases(items, topic) {
  const cases = [];
  items.forEach((it, i) => {
    const statement = pickStatement(it);
    if (!statement) return; // 无正文不可标注，跳过
    cases.push({
      id: `real-${topic.replace(/\s+/g, '-').slice(0, 10) || 'q'}-${i + 1}`,
      topic,
      statement,
      expected: 'unlabeled', // 真实内容无标准立场，待人工标注后改为 support/oppose/neutral/conditional
      note: '真实内容采样（未标注），来源=' + (it.Url || it.url || ''),
    });
  });
  return cases;
}

// 取 Items（容忍 A 形态 Data.Items 与 B 形态 items）
const envelope = raw.Data || raw;
const items = envelope?.Items || envelope?.items || [];
if (!Array.isArray(items) || items.length === 0) {
  console.error(`FAIL: 未在 ${rawArg} 中找到可采样的 Items 数组`);
  process.exit(1);
}
const topic = topicArg || envelope?.query || envelope?.topic || '未命名话题';

const cases = buildCases(items, topic);
const out = {
  meta: {
    version: 1,
    purpose: `真实检索内容回归集（采样自 ${rawArg}）。expected 均为 'unlabeled'，需人工补标（support/oppose/neutral/conditional）后，再用 _smoke_regression.mjs --real= 报告规则命中率。`,
    ...(holdout ? { split: 'holdout' } : {}),
    independence: holdout
      ? '语句取自真实 API 返回正文，非人工构造；该话题必须在规则调优冻结后采样，并由未参与调优的人工独立标注。'
      : '语句取自真实 API 返回正文，非人工构造；期望簇待人工按立场标注。runner 只报告分类结果与差异，作为修补规则或升级 LLM 判定的输入。',
    expected_limit: '真实噪声下规则分类 ≠ 语义理解；分歧率是聚类升级决策依据。',
    sampled_from: rawArg,
    sampled_at: new Date().toISOString(),
    skipped_no_text: items.length - cases.length,
  },
  cases,
};

const target = outFile || rawArg.replace(/\.json$/, '') + '.regression.json';
await writeFile(target, JSON.stringify(out, null, 2));
console.log(`采样完成: ${items.length} 条内容 → ${cases.length} 条可标注语句（${out.meta.skipped_no_text} 条无正文跳过）`);
console.log(`输出: ${target}`);
console.log(holdout
  ? '提示: 这是 holdout 草稿；合并至少 6 个话题并人工补标 support/oppose/conditional/insufficient 后，再运行 evaluate-holdout。'
  : `提示: 人工补标 cases[].expected 后运行: node _smoke_regression.mjs --real=${target}`);
