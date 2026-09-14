// merge-holdout.mjs — 合并多个真实话题草稿，生成独立留出集草稿。
// 不生成标签；所有 expected 必须由人工在规则冻结后补标。
// 用法：node scripts/merge-holdout.mjs --files=topic-a.json,topic-b.json -o data/holdout-cases.json
import { readFile, writeFile } from 'node:fs/promises';

const filesArg = process.argv.find((arg) => arg.startsWith('--files='));
const outArg = process.argv.find((arg) => arg === '-o');
const out = outArg ? process.argv[process.argv.indexOf(outArg) + 1] : 'data/holdout-cases.json';
if (!filesArg) {
  console.error('用法：node scripts/merge-holdout.mjs --files=a.json,b.json,... [-o data/holdout-cases.json]');
  process.exit(2);
}

const files = filesArg.slice('--files='.length).split(',').map((file) => file.trim()).filter(Boolean);
const cases = [];
const seenTopics = new Set();
for (const file of files) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data?.meta?.split !== 'holdout') throw new Error(`${file} 不是 holdout 草稿，请使用 sample-real.js --holdout`);
  for (const item of data.cases || []) {
    const topic = String(item.topic || '').trim();
    const statement = String(item.statement || '').trim();
    if (!topic || !statement) continue;
    seenTopics.add(topic);
    cases.push({
      id: `holdout-${topic.replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 24)}-${cases.length + 1}`,
      topic,
      statement,
      expected: 'unlabeled',
      note: item.note || `真实内容采样自 ${file}，待人工标注`,
    });
  }
}
if (!cases.length) throw new Error('没有可合并的真实样本');
const result = {
  meta: {
    version: 1,
    split: 'holdout',
    purpose: '规则调优冻结后采集的独立真实知乎回答留出集；expected 必须由人工标注。',
    independence: '样本来自未参与规则调优的新话题；合并后由未参与调优的人工按统一标注指南独立标注。',
    label_guide: 'expected 只能是 support、oppose、conditional、insufficient；unlabeled 不能进入正式评估。',
    source_files: files,
    topic_count: seenTopics.size,
    sampled_at: new Date().toISOString(),
  },
  cases,
};
await writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(`留出集草稿已生成: ${out} | ${cases.length} 条 | ${seenTopics.size} 个话题 | 仍待人工标注`);
