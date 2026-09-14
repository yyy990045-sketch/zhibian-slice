// 回归集 runner：对（人工标注的）回归集运行四簇分类，报告命中率与差异。
//
// 门禁语义（重要，改动前请读完）：
// 本 runner 是**防回退门禁**，不是质量门禁。规则分类器在口语化叙事语料上存在已知
// 天花板（30 例命中 22 例，未命中的 8 条记录在基线文件里），剩余差异属于「已知未覆盖」，
// 让 CI 长期飘红只会训练人忽略红灯 —— 那是换了姿势的假绿灯。
// 因此：已知未覆盖只报告；任何一条**曾经命中**的用例变回不命中，即判定为回退，立即非 0 退出。
// 由于基线用例是当前命中集合的子集，「命中数下降」必然伴随至少一条基线用例失效，
// 故逐条比对已覆盖计数比对，无需重复判据。
//
// 用法：
//   node _smoke_regression.mjs                     跑门禁（有回退则退出码 1）
//   node _smoke_regression.mjs --update-baseline   刷新基线（确认改进是有意的后执行）
//   node _smoke_regression.mjs --real=<file.json>  对真实检索语料做同 schema 评估（只报告）
//
// 背景：9/13 拿到真实数据后，可用 --real 跑真实内容，分歧率是
//      『继续补规则 or 升级为 LLM 判定』的决策输入。
import { readFile, writeFile } from 'node:fs/promises';
import { classifyText } from './src/cluster.js';

const realFlag = process.argv.find((a) => a.startsWith('--real='));
const file = realFlag ? realFlag.slice('--real='.length) : './regression-cases.json';
const updateBaseline = process.argv.includes('--update-baseline');
const BASELINE_FILE = './test/baseline-classification.json';

const data = JSON.parse(await readFile(file, 'utf-8'));
if (!Array.isArray(data.cases)) {
  console.error('FAIL: 缺少 cases 数组');
  process.exit(1);
}

const rows = [];
for (const c of data.cases) {
  const r = classifyText(c.statement);
  const labeled = c.expected !== 'unlabeled';
  rows.push({
    id: c.id,
    expected: c.expected,
    got: r.cluster,
    // 真实采样在人工复核前没有标准立场；unlabeled 只观察分类结果，
    // 不能把它计入分母，否则报告会把“待标注”误报成 0% 命中。
    labeled,
    ok: labeled ? r.cluster === c.expected : null,
    stance: r.stanceScore,
    note: c.note || '',
  });
}
const labeledRows = rows.filter((r) => r.labeled);
const unlabeledRows = rows.length - labeledRows.length;
const match = labeledRows.filter((r) => r.ok).length;
const pct = (labeledRows.length ? ((match / labeledRows.length) * 100).toFixed(0) : '—');

console.log(`回归集: ${file} | ${rows.length} 例 | 已标注命中 ${match}/${labeledRows.length} (${pct}${pct === '—' ? '' : '%'}) | 待人工标注 ${unlabeledRows}`);

// --real 是对未知语料的评估，没有基线可比，只报告不拦截
if (realFlag) {
  console.log('--- 真实语料评估（只报告） ---');
  for (const r of rows) {
    const mark = r.labeled ? (r.ok ? '√' : '×') : '·';
    const expected = r.labeled ? r.expected : '待标注';
    console.log(`  ${mark} [${r.id}] 期望=${expected} 实得=${r.got} (score=${r.stance}) | ${r.note}`);
  }
  process.exit(0);
}

let baseline = { match: 0, passing: [], updated: null };
try {
  baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf-8'));
} catch {
  console.log(`（未找到基线文件 ${BASELINE_FILE}，本次视为引导运行）`);
}

if (updateBaseline) {
  const next = {
    match,
    passing: rows.filter((r) => r.ok).map((r) => r.id),
    updated: new Date().toISOString().slice(0, 10),
  };
  await writeFile(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`基线已更新: ${match}/${rows.length}（${next.passing.length} 条记为「已命中」）`);
  process.exit(0);
}

const passingNow = new Set(rows.filter((r) => r.ok).map((r) => r.id));
const regressed = (baseline.passing || []).filter((id) => !passingNow.has(id));

console.log(`基线: ${baseline.match}/${rows.length}（${baseline.updated || '未知日期'}）`);
console.log('--- 未命中（已知未覆盖，不拦截） ---');
for (const r of rows) {
  if (r.labeled && !r.ok) console.log(`  [${r.id}] 期望=${r.expected} 实得=${r.got} (score=${r.stance}) | ${r.note}`);
}

if (regressed.length) {
  console.error(`\nFAIL: ${regressed.length} 条用例相对基线回退 → ${regressed.join(', ')}`);
  console.error('若为有意的分类调整，请复核后执行 --update-baseline 刷新基线。');
  process.exit(1);
}

if (!baseline.passing?.length) {
  console.error('\nFAIL: 基线为空，门禁未生效。请执行一次 --update-baseline 建立基线。');
  process.exit(1);
}

console.log(`PASS: 无回退（命中 ${match}/${rows.length}）`);
