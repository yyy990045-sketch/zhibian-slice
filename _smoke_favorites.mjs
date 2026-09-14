// 收藏夹校准冒烟：Mock 演示路径 + Http 代理路径（stub fetch）+ 管线可消费
import { MOCK_FAVORITES } from './src/mockData.js';
import { createAdapter, normalizeFavlists, normalizeFavlistContents } from './src/adapter.js';
import { fuse } from './src/fusion.js';
import { cluster } from './src/cluster.js';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}: ${m}`); if (!c) fail++; };

// ---- 1. user-api 字段归一化（官方样例结构） ----
const lists = normalizeFavlists({ Items: [{ UrlToken: 123456, Title: '职业选择', Description: 'desc' }] });
ok(lists[0].urlToken === '123456' && lists[0].title === '职业选择', 'favlists 归一化：UrlToken/Title/Description');
const contents = normalizeFavlistContents({ Items: [{
  ContentType: 'answer', Url: 'https://www.zhihu.com/answer/1', CreatedAt: 1700000000, FavTime: 1710000000,
  LikeCount: 120, CommentCount: 30, FavoriteCount: 8, Title: '我的收藏', Summary: '摘要内容',
  Author: { Name: '作者甲', Url: 'https://www.zhihu.com/people/a' },
}] });
const c0 = contents[0];
ok(c0.author === '作者甲' && c0.voteupCount === 120 && c0.excerpt === '摘要内容', 'favlist_contents 归一化：Author/LikeCount/Summary');
ok(/^\d{4}-\d{2}-\d{2}$/.test(c0.publishTime), `FavTime unix → 日期 (${c0.publishTime})`);
ok(c0.authorityLevel === 1, 'user-api 无权威度字段 → 默认 1');

// ---- 2. Mock 演示路径 ----
const mock = createAdapter({ mode: 'mock', topics: [], favorites: MOCK_FAVORITES });
const fl = await mock.favoritesLists();
ok(fl.ok && fl.items.length === 2 && fl.items[0].title === '职业选择', 'Mock favoritesLists：2 个演示收藏夹');
const fi = await mock.favoritesItems(fl.items[0].urlToken);
ok(fi.ok && fi.items.length > 0 && fi.demo === true, 'Mock favoritesItems：返回演示条目');
const fused = fuse(fi.items);
const clustered = cluster(fused);
ok(clustered.length === fi.items.length && clustered.every((i) => ['support', 'oppose', 'conditional', 'insufficient'].includes(i.cluster)), '收藏夹内容可被融合/聚类管线消费');
ok(clustered.some((i) => i.cluster !== 'insufficient'), `演示收藏夹产生非单一簇（分布: ${Object.entries(clustered.reduce((a, i) => { a[i.cluster] = (a[i.cluster] || 0) + 1; return a; }, {})).map(([k, v]) => `${k}=${v}`).join(' ')})`);

// ---- 3. Http 模式在 OAuth 会话未实现时必须明确降级，不能读取共享 token ----
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/me/favlist-contents')) return { ok: false, status: 501, json: async () => ({ reason: 'oauth_session_required' }) };
  if (u.includes('/me/favlists')) return { ok: false, status: 501, json: async () => ({ reason: 'oauth_session_required' }) };
  return { ok: false, status: 404, json: async () => ({ Code: 90001 }) };
};
const http = createAdapter({ mode: 'http' });
const hl = await http.favoritesLists();
ok(hl.reason === 'oauth_session_required', 'Http favoritesLists：无每用户 OAuth 会话时明确降级');
const hi = await http.favoritesItems('999');
ok(hi.reason === 'oauth_session_required', 'Http favoritesItems：无每用户 OAuth 会话时明确降级');
const bare = createAdapter({ mode: 'http' });
globalThis.fetch = async () => ({ ok: true, status: 503, json: async () => ({ reason: 'oauth_not_configured' }) });
const nb = await bare.favoritesLists();
ok(nb.reason === 'oauth_not_configured', '未配置 OAuth → oauth_not_configured 降级（不假装成功）');

console.log(fail ? `\nFAIL=${fail}` : '\nALL PASS');
process.exit(fail ? 1 : 0);
