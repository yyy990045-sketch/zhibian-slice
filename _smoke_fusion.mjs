// RRF 多路融合回归（US-11：fusion.js rrfFuse + 通道标记）
import { fuse, rrfFuse } from './src/fusion.js';

let failures = 0;
const ok = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`);
  if (!condition) failures += 1;
};

// 构造多路数据：同一内容出现在多路（应去重并累计 RRF 分）
const itemA = { id: 'a1', author: '甲', title: 'AI 取代程序员吗', excerpt: '支持', authorityLevel: 3, voteupCount: 100 };
const itemB = { id: 'b1', author: '乙', title: 'AI 只是工具', excerpt: '反对', authorityLevel: 4, voteupCount: 50 };
const itemC = { id: 'c1', author: '丙', title: '分情况讨论', excerpt: '条件', authorityLevel: 2, voteupCount: 10 };

// 1. 多路融合：去重 + 通道标记 + RRF 排序
const merged = rrfFuse([
  { source: 'search', items: [itemA, itemB, itemC] },
  { source: 'hot', items: [itemA, itemB] },       // a1/b1 重复出现
  { source: 'local', items: [itemC] },             // c1 重复出现
]);
ok(merged.length === 3, '多路融合去重（3 个唯一内容）');
ok(merged.every((it) => Array.isArray(it.channels) && it.channels.length >= 1), '每条都带通道标记');
const a = merged.find((it) => it.id === 'a1');
ok(a.channels.includes('search') && a.channels.includes('hot'), 'a1 通道标记含 search+hot');
const c = merged.find((it) => it.id === 'c1');
ok(c.channels.includes('search') && c.channels.includes('local'), 'c1 通道标记含 search+local');
ok(a.rrfScore > c.rrfScore, '多路重复出现的内容 RRF 分更高（a1 两路 > c1 两路排名位置更优）');

// 2. 无 id 回退键：只有作者、标题和正文都相同才去重，避免删掉相反观点
const noId = rrfFuse([{ source: 'search', items: [{ author: '丁', title: '同标题内容', excerpt: '同一正文' }] }, { source: 'hot', items: [{ author: '丁', title: '同标题内容', excerpt: '同一正文' }] }]);
ok(noId.length === 1, '无 id 时对完全相同的作者/标题/正文去重');
const similarNoId = rrfFuse([{ source: 'search', items: [{ author: '丁', title: '同标题内容（完整版）', excerpt: '支持' }] }, { source: 'hot', items: [{ author: '丁', title: '同标题内容（反驳）', excerpt: '反对' }] }]);
ok(similarNoId.length === 2, '无 id 时相似标题但正文不同的观点均保留');

// 3. 单路输入：退化行为正常
const single = rrfFuse([{ source: 'search', items: [itemB, itemA] }]);
ok(single.length === 2 && single[0].id === 'b1', '单路按 RRF 分排序（第 1 名优先）');
ok(typeof single[0].rrfScore === 'number', '单路也带 rrfScore');

// 4. 空/非法输入不崩
ok(rrfFuse([]).length === 0, '空通道列表返回空');
ok(rrfFuse([{ source: 'search', items: [] }]).length === 0, '空 items 返回空');
ok(rrfFuse([null, { source: 'x', items: [itemA] }]).length === 1, '非法通道被跳过');

// 5. topK 截断
const many = rrfFuse([{ source: 'search', items: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, author: 'a', title: `t${i}`, excerpt: '', authorityLevel: 1, voteupCount: 1 })) }], { topK: 5 });
ok(many.length === 5, 'topK=5 截断生效');

// 6. 既有 fuse() 单路行为不变（回归保护）
const fused = fuse([itemC, itemA, itemB]);
ok(fused.length === 3 && typeof fused[0].fusedScore === 'number', '既有 fuse() 行为不变');

console.log(failures ? `\nFAIL=${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
