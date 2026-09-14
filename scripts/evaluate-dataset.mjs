// evaluate-dataset.mjs — 分层数据集评估（Sprint 4）。
// 不调权、不写入开发基线；输出每类 Precision/Recall/F1、Macro-F1、混淆矩阵、
// 不确定率与可测性边界。没有来源/调用统计时明确报告未测，不用 0 冒充。
import { readFile, writeFile } from 'node:fs/promises';
import { classifyText } from '../src/cluster.js';

const fileArg = process.argv.find((arg) => arg.startsWith('--file='));
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const llmCallsArg = process.argv.find((arg) => arg.startsWith('--llm-calls='));
const totalCallsArg = process.argv.find((arg) => arg.startsWith('--total-calls='));
if (!fileArg) {
  console.error('用法：node scripts/evaluate-dataset.mjs --file=<dataset.json> [--out=<report.json>]');
  process.exit(2);
}

const labels = ['support', 'oppose', 'conditional', 'insufficient'];
const data = JSON.parse(await readFile(fileArg.slice('--file='.length), 'utf8'));
if (!Array.isArray(data?.cases) || !data.cases.length) {
  console.error('BLOCKED: 数据集 cases 为空');
  process.exit(2);
}

const confusion = Object.fromEntries(labels.map((label) => [label, Object.fromEntries(labels.map((x) => [x, 0]))]));
const started = performance.now();
const rows = data.cases.map((item) => {
  const result = classifyText(item.statement);
  const expected = labels.includes(item.expected) ? item.expected : null;
  if (expected) confusion[expected][result.cluster] += 1;
  return { id: item.id, expected, got: result.cluster, confidence: result.confidence, needsHumanReview: result.needsHumanReview };
});
const elapsedMs = performance.now() - started;
const labeled = rows.filter((row) => row.expected);
const metrics = {};
for (const label of labels) {
  const tp = labeled.filter((row) => row.expected === label && row.got === label).length;
  const fp = labeled.filter((row) => row.expected !== label && row.got === label).length;
  const fn = labeled.filter((row) => row.expected === label && row.got !== label).length;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
  metrics[label] = { support: labeled.filter((row) => row.expected === label).length, precision, recall, f1 };
}
const f1Values = Object.values(metrics).map((m) => m.f1).filter((v) => v !== null);
const report = {
  generatedAt: new Date().toISOString(),
  dataset: fileArg.slice('--file='.length),
  split: data.meta?.split || 'development',
  sampleCount: rows.length,
  labeledCount: labeled.length,
  accuracy: labeled.length ? labeled.filter((row) => row.expected === row.got).length / labeled.length : null,
  perClass: metrics,
  macroF1: f1Values.length ? f1Values.reduce((sum, value) => sum + value, 0) / f1Values.length : null,
  confusionMatrix: confusion,
  uncertaintyRate: rows.length ? rows.filter((row) => row.needsHumanReview || row.got === 'insufficient').length / rows.length : null,
  sourceBindingRate: 'not_measured: dataset cases do not contain source records',
  challengeValidity: 'not_measured: requires a source-backed challenge run',
  llmCallRatio: llmCallsArg && totalCallsArg ? Number(llmCallsArg.slice(12)) / Math.max(1, Number(totalCallsArg.slice(14))) : 'not_measured',
  averageLatencyMs: rows.length ? elapsedMs / rows.length : null,
  cost: 'not_measured: no billable LLM call in deterministic evaluator',
  errors: rows.filter((row) => row.expected && row.expected !== row.got),
};
console.log(JSON.stringify(report, null, 2));
if (outArg) await writeFile(outArg.slice('--out='.length), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
