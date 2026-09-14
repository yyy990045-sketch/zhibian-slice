// evaluate-holdout.mjs — 独立真实留出集评估，不写入 gold 基线，也不调权。
// 用法：node scripts/evaluate-holdout.mjs --file=data/holdout-cases.json
// 正式留出集默认要求至少 60 条、6 个未参与调优的话题，并且每条有人工标注依据 note。
import { readFile, writeFile } from 'node:fs/promises';
import { classifyText } from '../src/cluster.js';

const fileArg = process.argv.find((arg) => arg.startsWith('--file='));
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const minCases = Number(process.argv.find((arg) => arg.startsWith('--min-cases='))?.slice(12) || 60);
const minTopics = Number(process.argv.find((arg) => arg.startsWith('--min-topics='))?.slice(13) || 6);
const allowDraft = process.argv.includes('--allow-draft');
if (!fileArg) {
  console.error('BLOCKED: 请提供独立留出集：node scripts/evaluate-holdout.mjs --file=<holdout.json>');
  process.exit(2);
}

const file = fileArg.slice('--file='.length);
let data;
try {
  data = JSON.parse(await readFile(file, 'utf-8'));
} catch (error) {
  console.error(`BLOCKED: 无法读取留出集 ${file}：${error.code || error.message}`);
  process.exit(2);
}

if (data?.meta?.split !== 'holdout') {
  console.error('BLOCKED: 数据集必须声明 meta.split="holdout"，禁止把调优集冒充留出集。');
  process.exit(2);
}
if (!data?.meta?.independence || data.meta.independence.length < 20) {
  console.error('BLOCKED: 缺少可审计的独立性说明（meta.independence）。');
  process.exit(2);
}
if (!Array.isArray(data.cases) || data.cases.length === 0) {
  console.error('BLOCKED: 留出集 cases 为空。请先收集并人工标注真实回答。');
  process.exit(2);
}

const labels = ['support', 'oppose', 'conditional', 'insufficient'];
const allowed = new Set(labels);
const topics = new Set(data.cases.map((item) => String(item?.topic || '').trim()).filter(Boolean));
const invalid = data.cases.filter((item) => !item?.id || !item?.statement || !allowed.has(item.expected) || !item.note);
if (invalid.length) {
  console.error(`BLOCKED: ${invalid.length} 条样本缺少正文、人工标签或 note 标注依据；unlabeled 不能计入准确率。`);
  process.exit(2);
}
if (!allowDraft && data.cases.length < minCases) {
  console.error(`BLOCKED: 留出集只有 ${data.cases.length} 条，正式评估至少需要 ${minCases} 条；临时检查可加 --allow-draft。`);
  process.exit(2);
}
if (!allowDraft && topics.size < minTopics) {
  console.error(`BLOCKED: 留出集只有 ${topics.size} 个话题，正式评估至少需要 ${minTopics} 个未参与调优的话题；临时检查可加 --allow-draft。`);
  process.exit(2);
}

const confusion = Object.fromEntries(labels.map((label) => [label, Object.fromEntries(labels.map((x) => [x, 0]))]));
const started = performance.now();
const rows = data.cases.map((item) => {
  const result = classifyText(item.statement);
  confusion[item.expected][result.cluster] += 1;
  return {
    id: item.id,
    topic: item.topic,
    expected: item.expected,
    got: result.cluster,
    confidence: result.confidence,
    needsHumanReview: result.needsHumanReview,
    ok: result.cluster === item.expected,
  };
});
const elapsedMs = performance.now() - started;
const metrics = {};
for (const label of labels) {
  const tp = rows.filter((row) => row.expected === label && row.got === label).length;
  const fp = rows.filter((row) => row.expected !== label && row.got === label).length;
  const fn = rows.filter((row) => row.expected === label && row.got !== label).length;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
  metrics[label] = { support: rows.filter((row) => row.expected === label).length, precision, recall, f1 };
}
const f1Values = Object.values(metrics).map((metric) => metric.f1).filter((value) => value !== null);
const sourceRecords = data.cases.filter((item) => item.source?.id && item.source?.url && item.source?.excerpt);
const report = {
  generatedAt: new Date().toISOString(),
  dataset: file,
  split: data.meta.split,
  sampleCount: rows.length,
  topicCount: topics.size,
  labeledCount: rows.length,
  accuracy: rows.filter((row) => row.ok).length / rows.length,
  perClass: metrics,
  macroF1: f1Values.length ? f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length : null,
  confusionMatrix: confusion,
  uncertaintyRate: rows.filter((row) => row.needsHumanReview || row.got === 'insufficient').length / rows.length,
  sourceBindingRate: sourceRecords.length ? sourceRecords.length / rows.length : 'not_measured: holdout cases do not include source records',
  challengeValidity: 'not_measured: requires a separate source-backed challenge run',
  llmCallRatio: 'not_measured: deterministic holdout evaluator did not call an LLM',
  averageLatencyMs: elapsedMs / rows.length,
  cost: 'not_measured: no billable LLM call in deterministic evaluator',
  errors: rows.filter((row) => !row.ok),
};
console.log(JSON.stringify(report, null, 2));
if (outArg) await writeFile(outArg.slice('--out='.length), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
