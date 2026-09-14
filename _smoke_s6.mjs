// Sprint 6 稳定性与安全矩阵：超时、错误、输入边界、Origin/CSRF、无配置降级。
import http from 'node:http';
import { createAdapter } from './src/adapter.js';
import { createAppServer, createZhihuProxy } from './server.mjs';

let failures = 0;
const ok = (condition, message) => { console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`); if (!condition) failures += 1; };

const timeoutProxy = createZhihuProxy({
  accessSecret: 'fixture-access-value',
  upstreamTimeoutMs: 5,
  fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('simulated timeout')), 20);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
  }),
});
const timed = await timeoutProxy('GET', '/api/zhihu/search', new URLSearchParams({ query: '超时' }));
ok(timed.status === 504 && timed.body.reason === 'network_error', '上游超时降级为 network_error/504');
ok(timeoutProxy.stats().errors === 1, '上游超时计入 errors');

const empty = await createAdapter({ mode: 'mock', topics: [] }).search('不存在');
ok(empty.empty && empty.reason === 'no_result', '无搜索结果返回可理解的 no_result');
const unconfigured = await createAdapter({ mode: 'http', httpConfig: { proxyBase: 'http://127.0.0.1:1/api/zhihu' } }).search('x');
ok(unconfigured.reason === 'network_error', '代理不可达时浏览器侧回退 network_error');

const longProxy = createZhihuProxy({ accessSecret: 's', fetchImpl: async () => { throw new Error('should not call'); } });
const longQuery = await longProxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'x'.repeat(501) }));
ok(longQuery.status === 400, '过长搜索词在服务端拒绝且不触发上游');

const server = createAppServer({ accessSecret: 's', allowedOrigins: ['http://127.0.0.1:4173'], rateLimitMax: 20, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) }) });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const request = (method, path, headers = {}, body = '') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});
const tooLarge = await request('POST', '/api/zhihu/direct-answer', { Origin: 'http://127.0.0.1:4173', 'Content-Type': 'application/json' }, JSON.stringify({ query: 'x'.repeat(17_000) }));
ok(tooLarge.status === 413, '请求体超限返回 413，不白屏');
const invalidJson = await request('POST', '/api/zhihu/direct-answer', { Origin: 'http://127.0.0.1:4173', 'Content-Type': 'application/json' }, '{');
ok(invalidJson.status === 400, '非法 JSON 返回 400');
const unknown = await request('GET', '/does-not-exist');
ok(unknown.status === 404, '未知路径返回 404');
server.close();

console.log(failures ? `\nFAIL=${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
