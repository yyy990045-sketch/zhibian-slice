// compare-eval.mjs — 评测基线门禁（US-18，R8 compareEvaluationRuns 思路）
// 用途：跑回归集 → 报告命中率 → 与基线注册表对比；命中率下降超过阈值 → exit 1（阻止劣化提交）。
// 关键原则（诚实边界）：命中率提升 ≠ 调权依据。基线注册表只记录「分类器实际表现」的趋势，
//   不把某个数字当作「规则已够好」的证据；真实数据接入后（9/13），分歧率才是『修补规则 or
//   升级 LLM 判定』的决策输入（见 ADR-0001）。
//
// 用法：
//   node scripts/compare-eval.mjs                          # 跑默认回归集并更新基线
//   node scripts/compare-eval.mjs --real=<file.json>       # 跑真实采样集（会登记为独立基线）
//   node scripts/compare-eval.mjs --delta=10               # 允许命中率下降阈值（百分比点）
//   node scripts/compare-eval.mjs --check                  # 只检查不更新基线
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { classifyText } from '../src/cluster.js';

const BASELINE_FILE = resolve(import.meta.dirname, '../data/eval-baseline.json');

const realFlag = process.argv.find((a) => a.startsWith('--real='));
const datasetFile = realFlag ? realFlag.slice('--real='.length) : './regression-cases.json';
const key = realFlag ? `real:${datasetFile}` : 'gold';
const delta = Number(process.argv.find((a) => a.startsWith('--delta='))?.slice('--delta='.length) || 5);
const checkOnly = process.argv.includes('--check');

const data = JSON.parse(await readFile(datasetFile, 'utf-8'));
if (!Array.isArray(data.cases) || !data.cases.length) {
  console.error('FAIL: 数据集缺少 cases');
  process.exit(1);
}

// 跑分类
let match = 0;
const rows = [];
for (const c of data.cases) {
  const r = classifyText(c.statement);
  const ok = r.cluster === c.expected;
  if (ok) match += 1;
  rows.push({ id: c.id, expected: c.expected, got: r.cluster, ok, note: c.note || '' });
}
const total = rows.length;
const pct = Number(((match / total) * 100).toFixed(1));

console.log(`评测: ${datasetFile} | ${total} 例 | 命中 ${match}/${total} (${pct}%)`);

// 读基线注册表
let registry = { version: 1, runs: {} };
try {
  registry = JSON.parse(await readFile(BASELINE_FILE, 'utf-8'));
} catch {
  registry = { version: 1, runs: {} };
}
const prev = registry.runs[key];

const prevPct = prev?.pct;
if (prevPct !== undefined) {
  const drop = prevPct - pct;
  console.log(`基线: ${key} 上次 ${prevPct}% (${prev.date}) | 本次 ${pct}% | Δ=${drop >= 0 ? '-' : '+'}${Math.abs(drop).toFixed(1)}pt`);
  if (drop > delta) {
    console.error(`FAIL: 命中率较上次下降 ${drop.toFixed(1)}pt 超过阈值 ${delta}pt，请勿在分类器劣化时提交`);
    for (const r of rows) if (!r.ok) console.error(`  [${r.id}] 期望=${r.expected} 实得=${r.got} | ${r.note}`);
    process.exit(1);
  }
} else {
  console.log(`基线: ${key} 尚无记录，本次 ${pct}% 将作为首条基线（诚实标注：单次结果不代表稳定性）`);
}

// 差异报告（只报告，不调权）
const diffRows = rows.filter((r) => !r.ok);
console.log(`--- 差异 ${diffRows.length}/${total}（仅报告，决策见 ADR-0001） ---`);
for (const r of diffRows) console.log(`  [${r.id}] 期望=${r.expected} 实得=${r.got} | ${r.note}`);

// 更新基线（check 模式不写入）
if (!checkOnly) {
  registry.runs[key] = { date: new Date().toISOString(), total, match, pct, dataset: datasetFile };
  await mkdir(dirname(BASELINE_FILE), { recursive: true });
  await writeFile(BASELINE_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  console.log(`基线已登记: ${BASELINE_FILE}`);
}
process.exit(0);
