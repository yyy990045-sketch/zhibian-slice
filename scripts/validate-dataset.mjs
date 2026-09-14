// validate-dataset.mjs — 回归集（Gold Set）schema 校验 + checksum（US-17）
// 用途：
//   1) 校验回归集 schema：meta 存在、cases 为数组、id 唯一、expected 为四簇枚举、statement 非空、topic 非空
//   2) 计算并（可选）回写 meta.checksum，保证「9/13 前后数据集未被篡改」的可审计性
//   3) 带 --real 时额外校验：来源标记 note 非空（真实采样条目必须有出处）
// 用法：
//   node scripts/validate-dataset.mjs regression-cases.json          # 校验并打印 checksum
//   node scripts/validate-dataset.mjs regression-cases.json --write   # 校验并把 checksum 回写 meta
//   node scripts/validate-dataset.mjs real.json --real                # 真实采样集：额外要求 note 来源标记
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// 与 src/cluster.js CLUSTER_ORDER 保持一致的四簇枚举（单一事实源）
const EXPECTED = new Set(['support', 'oppose', 'conditional', 'insufficient']);
const file = process.argv[2];
const writeMeta = process.argv.includes('--write');
const isReal = process.argv.includes('--real');

if (!file) {
  console.error('用法: node scripts/validate-dataset.mjs <dataset.json> [--write] [--real]');
  process.exit(1);
}

const data = JSON.parse(await readFile(file, 'utf-8'));
const errors = [];

if (!data.meta || typeof data.meta !== 'object') errors.push('缺少 meta 对象（Gold Set 必须声明 purpose/independence）');
else {
  for (const k of ['purpose', 'independence']) if (!data.meta[k]) errors.push(`meta 缺少 ${k}（诚实性声明缺失）`);
}

if (!Array.isArray(data.cases) || data.cases.length === 0) errors.push('cases 必须为非空数组');
else {
  const ids = new Set();
  const topics = new Set();
  data.cases.forEach((c, i) => {
    const at = `cases[${i}]`;
    if (!c.id) errors.push(`${at} 缺少 id`);
    else if (ids.has(c.id)) errors.push(`${at} id 重复: ${c.id}`);
    else ids.add(c.id);
    if (!c.statement || !String(c.statement).trim()) errors.push(`${at} statement 为空`);
    if (!EXPECTED.has(c.expected)) errors.push(`${at} expected 非法: ${c.expected}（应为 ${[...EXPECTED].join('|')}）`);
    if (!c.topic || !String(c.topic).trim()) errors.push(`${at} topic 为空`);
    else topics.add(c.topic);
    if (isReal && !c.note) errors.push(`${at} 真实采样条目缺少 note 来源标记`);
  });
  if (topics.size < 3) errors.push(`话题覆盖不足：仅 ${topics.size} 个 topic（Gold Set 至少 3 个话题）`);
}

// 统计四簇分布（Gold Set 平衡性观测，不强制均衡）
const dist = {};
data.cases?.forEach((c) => { dist[c.expected] = (dist[c.expected] || 0) + 1; });

if (errors.length) {
  console.error(`FAIL: ${file} 校验未通过（${errors.length} 项）`);
  errors.forEach((e) => console.error(`  - ${e}`));
  console.error(`四簇分布: ${JSON.stringify(dist)}`);
  process.exit(1);
}

// checksum：对 cases 正文（剔除 meta，防校验自身漂移）取 sha256
const payload = JSON.stringify(data.cases.map((c) => ({ id: c.id, statement: c.statement, expected: c.expected, topic: c.topic })));
const checksum = createHash('sha256').update(payload).digest('hex').slice(0, 16);

if (writeMeta) {
  data.meta.checksum = checksum;
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`OK: ${file} 校验通过，checksum=${checksum} 已回写 meta.checksum`);
} else {
  console.log(`OK: ${file} 校验通过（${data.cases.length} 例 / ${[...new Set(data.cases.map((c) => c.topic))].length} 话题），checksum=${checksum}`);
}
console.log(`四簇分布: ${JSON.stringify(dist)}`);
process.exit(0);
