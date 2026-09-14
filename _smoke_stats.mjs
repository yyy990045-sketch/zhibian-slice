// 缓存可观测性 + 配额保护回归。
import http from 'node:http';
import { createZhihuProxy, createAppServer } from './server.mjs';
import { createAdapter } from './src/adapter.js';

let failures = 0;
const ok = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`);
  if (!condition) failures += 1;
};

// ---------- 1. 代理层 stats：缓存命中不重复计上游 ----------
const upstream = [];
const proxy = createZhihuProxy({
  accessSecret: 'fixture-access-value',
  fetchImpl: async (url) => {
    upstream.push(String(url));
    return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) };
  },
});
const params = new URLSearchParams({ query: '立场校准' });
const first = await proxy('GET', '/api/zhihu/search', params);
const second = await proxy('GET', '/api/zhihu/search', params); // 缓存命中
ok(first.status === 200 && second.status === 200, '两次同话题检索均返回 200');
ok(upstream.length === 1, '缓存命中不重复发起上游调用（上游仅 1 次）');

const s1 = proxy.stats();
ok(s1.upstreamCalls === 1, 'upstreamCalls 计数为 1');
ok(s1.cacheHits === 1, 'cacheHits 计数为 1（第二次为缓存命中）');
ok(s1.errors === 0, '无错误时 errors 为 0');
ok(s1.quota.search.used === 1 && s1.quota.search.limit === 5000, '搜索配额 used=1 / limit=5000');
ok(s1.quota.hot.limit === 100 && s1.quota.directAnswer.limit === 100, '热榜/直答配额 limit 分别为 100');

// 热榜 + 直答 也计入对应配额
await proxy('GET', '/api/zhihu/hot', new URLSearchParams({ limit: '5' }));
await proxy('POST', '/api/zhihu/direct-answer', new URLSearchParams(), { query: '立场校准' });
const s2 = proxy.stats();
ok(s2.upstreamCalls === 3, '三类接口累计 upstreamCalls=3');
ok(s2.quota.hot.used === 1 && s2.quota.directAnswer.used === 1, '热榜/直答配额各 used=1');
ok(typeof s2.cacheHits === 'number', 'stats 快照含 cacheHits 字段');

// ---------- 2. 上游错误计入 errors，且不污染缓存 ----------
const errProxy = createZhihuProxy({
  accessSecret: 'fixture-access-value',
  fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ Code: 500, Message: 'boom' }) }),
});
await errProxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'y' }));
ok(errProxy.stats().errors === 1, '上游 5xx / 业务错误码计入 errors');

// ---------- 3. 适配器同话题去抖（客户端缓存，避免重复扣配额） ----------
const clientCalls = [];
globalThis.fetch = async (url, init = {}) => {
  clientCalls.push({ url: String(url), init });
  if (String(url).includes('/search')) return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) };
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
};
const browser = createAdapter({ mode: 'http' });
await browser.search('去抖验证');
await browser.search('去抖验证'); // TTL 内缓存命中
const searchCalls = clientCalls.filter(({ url }) => url.includes('/search'));
ok(searchCalls.length === 1, 'HttpProvider 同话题去抖：两次检索仅一次 /api/zhihu/search 请求');

// ---------- 4. stats HTTP 端点（经由应用服务器） ----------
const server = createAppServer({
  provider: 'mock',
  accessSecret: 'fixture-access-value',
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const getJson = (path) => new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}${path}`, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => resolve({ status: r.statusCode, body: d }));
  }).on('error', reject);
});

const statsResp = await getJson('/api/zhihu/stats');
ok(statsResp.status === 200, 'GET /api/zhihu/stats 返回 200');
const statsPayload = JSON.parse(statsResp.body);
ok(typeof statsPayload.upstreamCalls === 'number' && typeof statsPayload.quota === 'object', 'stats 端点返回 upstreamCalls 与 quota 字段');
ok(!JSON.stringify(statsPayload).includes('secret') && !JSON.stringify(statsPayload).includes('Bearer'), 'stats 端点不含 Secret / 鉴权头');

const idxResp = await getJson('/');
ok(idxResp.status === 200 && idxResp.body.includes('data-provider="mock"'), 'index.html 注入运行时 provider');
server.close();

console.log(failures ? `\nFAIL=${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
