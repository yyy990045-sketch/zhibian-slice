// 冒烟测试：挑战生成器（source-gated）+ 直答对照片字段
import { MOCK_TOPICS } from './src/mockData.js';
import { createAdapter } from './src/adapter.js';
import { fuse } from './src/fusion.js';
import { cluster } from './src/cluster.js';
import { generateChallenges } from './src/challenge.js';

const adapter = createAdapter({ mode: 'mock', topics: MOCK_TOPICS });
let fail = 0;
const group = (cl) => ({
  support: { items: cl.filter((i) => i.cluster === 'support') },
  oppose: { items: cl.filter((i) => i.cluster === 'oppose') },
  conditional: { items: cl.filter((i) => i.cluster === 'conditional') },
  insufficient: { items: cl.filter((i) => i.cluster === 'insufficient') },
});

for (const t of MOCK_TOPICS) {
  const res = await adapter.search(t.query);
  if (!res.ok || res.empty) { console.error('search failed', t.query); fail++; continue; }
  const cl = cluster(fuse(res.items));
  const clusters = group(cl);
  for (const stance of ['支持', '反对', '中立']) {
    const ch = generateChallenges({ userStance: stance, clusters, summary: { total: cl.length } });
    for (const c of ch) {
      if (!c.sourceRef) { console.error('UNGATED', t.id, stance, c.type); fail++; }
      if (!c.text || c.text.length < 8) { console.error('thin text', t.id, stance, c.type); fail++; }
    }
    console.log(`${t.id} | ${stance} | n=${ch.length} | ${ch.map((c) => c.type).join(',') || '—'}`);
  }
  const da = await adapter.directAnswer(t.query);
  if (!da.ok || da.empty) { console.error('directAnswer failed', t.id); fail++; }
  else if (!da.answer || !da.citations?.length) { console.error('directAnswer empty fields', t.id); fail++; }
  else console.log(`${t.id} | directAnswer OK | citations=${da.citations.length} | daQuota=${da.quota.used}/${da.quota.limit}`);
}
console.log(fail ? `\nFAIL=${fail}` : '\nALL PASS');
process.exit(fail ? 1 : 0);
