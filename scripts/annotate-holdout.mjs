// annotate-holdout.mjs — 本地人工标注留出集，不修改原始草稿。
// 用法：
//   node scripts/annotate-holdout.mjs --file=<holdout-draft.json> --out=<holdout-labeled.json> --annotator=<name>
//   node scripts/annotate-holdout.mjs --file=<holdout-labeled.json> --check
// 说明：只接受人工输入；退出或跳过会保留未标注状态，正式评估仍会阻断。
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export const LABELS = ['support', 'oppose', 'conditional', 'insufficient'];
const ALLOWED = new Set(LABELS);

function hasCompleteAnnotation(item) {
  return ALLOWED.has(item?.expected)
    && String(item?.annotation?.rationale || '').trim().length > 0
    && String(item?.annotation?.annotator || '').trim().length > 0
    && item?.annotation?.method === 'independent-human';
}

function argValue(name, fallback = '') {
  const arg = process.argv.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1).trim() : fallback;
}

export function validateHoldoutDraft(data) {
  const errors = [];
  if (data?.meta?.split !== 'holdout') errors.push('meta.split 必须是 holdout');
  if (!Array.isArray(data?.cases) || data.cases.length === 0) {
    errors.push('cases 必须是非空数组');
    return errors;
  }

  const ids = new Set();
  data.cases.forEach((item, index) => {
    const at = `cases[${index}]`;
    if (!item?.id || ids.has(item.id)) errors.push(`${at} id 缺失或重复`);
    else ids.add(item.id);
    if (!String(item?.topic || '').trim()) errors.push(`${at} topic 为空`);
    if (!String(item?.statement || '').trim()) errors.push(`${at} statement 为空`);
    if (!String(item?.note || '').trim()) errors.push(`${at} note 为空，无法审计来源`);
    if (item?.expected !== 'unlabeled') {
      if (!ALLOWED.has(item?.expected)) errors.push(`${at} expected 非法: ${item?.expected}`);
      else if (!hasCompleteAnnotation(item)) errors.push(`${at} 缺少完整人工标注依据或元数据`);
    }
  });
  return errors;
}

export function validateAnnotation(label, rationale, annotator) {
  const errors = [];
  if (!ALLOWED.has(label)) errors.push(`标签必须是 ${LABELS.join('|')}`);
  if (!String(rationale || '').trim()) errors.push('依据不能为空');
  if (!String(annotator || '').trim()) errors.push('annotator 不能为空');
  return errors;
}

export function annotateCase(item, { label, rationale, annotator, annotatedAt }) {
  const errors = validateAnnotation(label, rationale, annotator);
  if (errors.length) throw new Error(errors.join('；'));
  return {
    ...item,
    expected: label,
    annotation: {
      label,
      rationale: String(rationale).trim(),
      annotator: String(annotator).trim(),
      method: 'independent-human',
      guideVersion: 'v1',
      annotatedAt,
    },
  };
}

export function summarizeAnnotations(data) {
  const counts = Object.fromEntries([...LABELS, 'unlabeled'].map((label) => [label, 0]));
  for (const item of data.cases || []) {
    const label = hasCompleteAnnotation(item) ? item.expected : 'unlabeled';
    counts[label] += 1;
  }
  return { total: data.cases?.length || 0, counts, labeled: counts.unlabeled === 0 };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 JSON ${file}: ${error.code || error.message}`);
  }
}

async function atomicWriteJson(file, data) {
  const temp = `${file}.partial-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

function buildOutput(draft, previous, annotator, startedAt) {
  const previousById = new Map((previous?.cases || []).map((item) => [item.id, item]));
  const cases = draft.cases.map((item) => {
    const prior = previousById.get(item.id);
    return prior && hasCompleteAnnotation(prior)
      ? { ...item, ...prior }
      : { ...item, expected: 'unlabeled' };
  });
  return {
    ...draft,
    meta: {
      ...draft.meta,
      annotation: {
        status: 'in-progress',
        method: 'independent-human',
        guideVersion: 'v1',
        annotator: annotator.trim(),
        startedAt,
        sourceDraft: basename(argValue('--file')),
      },
    },
    cases,
  };
}

function printCase(item, index, total) {
  console.log(`\n[${index + 1}/${total}] ${item.id}`);
  console.log(`话题：${item.topic}`);
  console.log(`来源备注：${item.note}`);
  console.log('原文：');
  console.log(item.statement);
}

async function runInteractive({ file, out, annotator }) {
  if (resolve(file) === resolve(out)) throw new Error('标注输出必须是新文件，不能覆盖原始草稿');
  const draft = await readJson(file);
  const draftErrors = validateHoldoutDraft(draft);
  if (draftErrors.length) throw new Error(`输入草稿不合格：${draftErrors.join('；')}`);

  let previous;
  try {
    previous = await readJson(out);
  } catch (error) {
    if (!['ENOENT', 'EISDIR'].includes(error.cause?.code) && !String(error.message).includes('ENOENT')) throw error;
  }
  const startedAt = previous?.meta?.annotation?.startedAt || new Date().toISOString();
  const result = buildOutput(draft, previous, annotator, startedAt);
  const rl = readline.createInterface({ input, output });
  let quit = false;

  try {
    for (let index = 0; index < result.cases.length; index += 1) {
      const item = result.cases[index];
      if (hasCompleteAnnotation(item)) continue;
      printCase(item, index, result.cases.length);
      const labelInput = (await rl.question(`标签 [${LABELS.join('/')}，q=保存退出]：`)).trim().toLowerCase();
      if (labelInput === 'q') {
        quit = true;
        break;
      }
      if (!ALLOWED.has(labelInput)) {
        console.log('未保存：标签不合法，请重新运行后继续。');
        break;
      }
      const rationale = await rl.question('人工依据（必填）：');
      const errors = validateAnnotation(labelInput, rationale, annotator);
      if (errors.length) {
        console.log(`未保存：${errors.join('；')}`);
        break;
      }
      result.cases[index] = annotateCase(item, {
        label: labelInput,
        rationale,
        annotator,
        annotatedAt: new Date().toISOString(),
      });
      result.meta.annotation.status = 'in-progress';
      await atomicWriteJson(out, result);
      console.log(`已保存 ${item.id}，原始草稿未修改。`);
    }
  } finally {
    rl.close();
  }

  const summary = summarizeAnnotations(result);
  result.meta.annotation.status = summary.labeled ? 'complete' : 'in-progress';
  await atomicWriteJson(out, result);
  console.log(`\n${quit ? '已保存并退出' : '标注流程结束'}：${out}`);
  console.log(`进度：${summary.total - summary.counts.unlabeled}/${summary.total} 条；${summary.counts.unlabeled ? '仍有未标注，正式评测会阻断。' : '可进入正式评测。'}`);
}

async function runCheck(file) {
  const data = await readJson(file);
  const errors = validateHoldoutDraft(data);
  if (errors.length) throw new Error(`数据不合格：${errors.join('；')}`);
  const summary = summarizeAnnotations(data);
  console.log(JSON.stringify({ file, ...summary }, null, 2));
  if (!summary.labeled) process.exitCode = 2;
}

async function main() {
  const file = argValue('--file');
  const out = argValue('--out', file);
  const annotator = argValue('--annotator');
  const check = process.argv.includes('--check');
  if (!file) throw new Error('用法：node scripts/annotate-holdout.mjs --file=<input.json> --out=<labeled.json> --annotator=<name>');
  if (check) return runCheck(file);
  if (!out || !annotator) throw new Error('交互标注必须提供 --out=<labeled.json> 和 --annotator=<name>');
  return runInteractive({ file, out, annotator });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`BLOCKED: ${error.message}`);
    process.exitCode = 2;
  });
}
