import { classifyText, cluster } from './src/cluster.js';

let failures = 0;
const ok = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`);
  if (!condition) failures += 1;
};

ok(classifyText('我认为不应该把所有钱都存起来').cluster === 'oppose', '否定句“不应该”不会误判为支持');
ok(classifyText('分析了充分理由，但没有给出限定结论').cluster !== 'conditional', '单字“分”不再触发条件簇');
ok(classifyText('我存了三年的钱，后悔没早点行动').cluster === 'insufficient', '非词表表达明确标记为证据不足，不伪装语义理解');
const items = cluster([
  { id: 'n1', excerpt: '不应该盲目考研', featuredComment: '', authorityLevel: 2, voteupCount: 1 },
  { id: 'n2', excerpt: '分析了充分理由', featuredComment: '', authorityLevel: 2, voteupCount: 1 },
]);
ok(items[0].cluster === 'oppose' && items[1].cluster === 'insufficient', '批量聚类保留修复后的分类结果');
console.log(failures ? `\nFAIL=${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
