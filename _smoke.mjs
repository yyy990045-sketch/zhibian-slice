import { MOCK_TOPICS } from './src/mockData.js';
import { fuse } from './src/fusion.js';
import { cluster, CLUSTER_META } from './src/cluster.js';
import { computeLayout, computeSummary } from './src/spectrum.js';
import { createAdapter } from './src/adapter.js';

let allOk = true;
for (const topic of MOCK_TOPICS) {
  const fused = fuse(topic.items);
  const clustered = cluster(fused);
  const layout = computeLayout(clustered);
  const summary = computeSummary(clustered);

  // 基本断言
  const okLen = clustered.length === topic.items.length;
  const okClusters = clustered.every((c) => CLUSTER_META[c.cluster]);
  const okXY = layout.every((n) => n.x >= -1.2 && n.x <= 1.2 && n.y >= 0 && n.y <= 1);
  const okCounts = Object.values(summary.counts).reduce((a, b) => a + b, 0) === topic.items.length;
  const okStance = Object.values(summary.stanceCounts).reduce((a, b) => a + b, 0) === topic.items.length;
  const okArgument = Object.values(summary.argumentCounts).reduce((a, b) => a + b, 0) === topic.items.length;

  console.log(`\n=== ${topic.query} ===`);
  console.log('融合后条数:', fused.length, '| 去重OK:', okLen);
  console.log('四簇分布:', summary.counts);
  console.log('立场分布:', summary.stanceCounts, '| 论证性质:', summary.argumentCounts);
  console.log('立场重心:', summary.centerLabel, summary.center, '| 各簇平均扎实度:', summary.avgEvidence, '| 各簇平均热度:', summary.avgHeat);
  console.log('校验: 簇合法', okClusters, '| 坐标合法', okXY, '| 计数守恒', okCounts, '| 立场守恒', okStance, '| 论证守恒', okArgument);
  if (!(okLen && okClusters && okXY && okCounts && okStance && okArgument)) allOk = false;
}
console.log('\n>>> SMOKE RESULT:', allOk ? 'PASS' : 'FAIL');

const configuredButOffline = await createAdapter({ mode: 'http', httpConfig: { proxyBase: 'http://127.0.0.1:1/api/zhihu' } }).search('任意问题');
const adapterOk = configuredButOffline.reason === 'network_error';
console.log('适配层降级: 同源代理离线', configuredButOffline.reason);
allOk = allOk && adapterOk;
console.log('>>> ADAPTER RESULT:', adapterOk ? 'PASS' : 'FAIL');
process.exit(allOk ? 0 : 1);
