// 服务端工程增强回归（US-02 结构化日志 / US-03 env 门禁 / US-04 限流+告警 / US-05 链路 ID+拒绝观测 / US-10 CSRF）
import http from 'node:http';
import { createZhihuProxy, createAppServer, validateEnv, createRateLimiter, csrfGuard } from './server.mjs';
import { sanitizePayload, jsonLog } from './src/logger.js';

let failures = 0;
const ok = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`);
  if (!condition) failures += 1;
};

// ---------- US-03 env 启动门禁 ----------
ok(validateEnv({ production: true, provider: 'mock', allowedOrigins: [] }).includes('ZHIBIAN_ALLOWED_ORIGINS'), '生产模式缺 Origin 列入缺失项');
ok(validateEnv({ production: true, provider: 'http', allowedOrigins: ['https://demo.example'], accessSecret: '' }).includes('ZHIHU_ACCESS_SECRET'), 'http provider 缺 Secret 列入缺失项');
ok(validateEnv({ production: true, provider: 'http', allowedOrigins: ['https://demo.example'], accessSecret: 'fixture-model-value' }).length === 0, '生产+http+齐全 env 通过门禁');
ok(validateEnv({ production: false, provider: 'mock' }).length === 0, '本地 mock 模式无需门禁强制项');

// ---------- US-02 结构化日志 + PII 脱敏 ----------
const masked = sanitizePayload({ query: 'AI', body: { query: 'x', Authorization: 'Bearer fixture-secret', token: 'fixture-token' }, nested: { password: 'fixture-password' } });
ok(masked.query === 'AI' && masked.nested.password === '[REDACTED]', '敏感键 password 脱敏，普通字段保留');
ok(masked.body.Authorization === '[REDACTED]' && masked.body.token === '[REDACTED]', 'Authorization/token 脱敏');
const line = jsonLog('info', 'request', { reqId: 'r1', status: 200 });
ok(typeof line === 'string' && line.includes('"reqId":"r1"') && line.includes('"level":"info"'), 'jsonLog 输出结构化 JSON 行');

// ---------- US-05 拒绝观测：403/501/400 计入 refusals ----------
const proxy = createZhihuProxy({
  accessSecret: 's',
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) }),
});
await proxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'x' }), undefined, 'https://evil.example'); // 403
await proxy('GET', '/api/zhihu/me/favlists', new URLSearchParams()); // 501
await proxy('GET', '/api/zhihu/search', new URLSearchParams()); // 400 缺 query
ok(proxy.stats().refusals === 3, '403/501/400 三类拒绝各计入 refusals（共 3）');
ok(proxy.stats().upstreamCalls === 0, '拒绝路径不消耗上游配额');

// ---------- US-04 限流（纯函数） ----------
const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
ok(limiter.check('1.2.3.4').allowed && limiter.check('1.2.3.4').allowed && limiter.check('1.2.3.4').allowed, '前 3 次放行');
ok(!limiter.check('1.2.3.4').allowed, '第 4 次超限被拒');
ok(limiter.check('9.9.9.9').allowed, '不同 IP 不受影响');

// ---------- US-10 CSRF（纯函数） ----------
const fakeReq = { method: 'POST', headers: {} };
ok(csrfGuard(fakeReq, new URL('http://127.0.0.1/api/zhihu/direct-answer'), ['http://127.0.0.1:4173']).status === 400, 'POST 无 Origin → 400 csrf_origin_required');
ok(csrfGuard({ ...fakeReq, headers: { origin: 'https://evil.example' } }, new URL('http://127.0.0.1/api/zhihu/direct-answer'), ['http://127.0.0.1:4173']).status === 403, '陌生 Origin POST → 403');
ok(csrfGuard({ ...fakeReq, headers: { origin: 'http://127.0.0.1:4173' } }, new URL('http://127.0.0.1/api/zhihu/direct-answer'), ['http://127.0.0.1:4173']) === null, '白名单 Origin POST 放行');
ok(csrfGuard({ method: 'GET', headers: {} }, new URL('http://127.0.0.1/api/zhihu/search'), []) === null, 'GET 不触发 CSRF');

// ---------- HTTP 层端到端 A：X-Request-Id / stats.refusals / CSRF（默认限流 60，不干扰） ----------
const serverA = createAppServer({
  accessSecret: 'fixture-access-value',
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) }),
});
await new Promise((r) => serverA.listen(0, '127.0.0.1', r));
const portA = serverA.address().port;

const mkReq = (port) => (method, path, headers = {}, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
  });
  r.on('error', reject);
  if (body) r.write(body);
  r.end();
});
const reqA = mkReq(portA);

// X-Request-Id 响应头
const r1 = await reqA('GET', '/api/zhihu/stats');
ok(typeof r1.headers['x-request-id'] === 'string' && r1.headers['x-request-id'].length > 0, 'HTTP 响应带 X-Request-Id');

// stats 端点含 refusals 字段
const s = JSON.parse(r1.body);
ok(typeof s.refusals === 'number', 'stats 端点含 refusals 计数');

// CSRF 403：POST 无 Origin / 陌生 Origin / 白名单放行
const csrfBlocked = await reqA('POST', '/api/zhihu/direct-answer', { 'Content-Type': 'application/json' });
ok(csrfBlocked.status === 400, 'HTTP POST 无 Origin → 400');
const csrfEvil = await reqA('POST', '/api/zhihu/direct-answer', { 'Content-Type': 'application/json', Origin: 'https://evil.example' });
ok(csrfEvil.status === 403, 'HTTP POST 陌生 Origin → 403');
const csrfOk = await reqA('POST', '/api/zhihu/direct-answer', { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4173' }, JSON.stringify({ query: '立场校准' }));
ok(csrfOk.status === 200, '白名单 Origin POST 放行（200）');
serverA.close();

// ---------- HTTP 层端到端 B：限流 429（独立小配额实例，避免同 IP 干扰其他用例） ----------
const serverB = createAppServer({
  accessSecret: 'fixture-access-value',
  rateLimitMax: 3,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) }),
});
await new Promise((r) => serverB.listen(0, '127.0.0.1', r));
const portB = serverB.address().port;
const reqB = mkReq(portB);
await reqB('GET', '/api/zhihu/stats');
await reqB('GET', '/api/zhihu/stats');
await reqB('GET', '/api/zhihu/stats');
const limited = await reqB('GET', '/api/zhihu/stats');
ok(limited.status === 429 && JSON.parse(limited.body).error.code === 'rate_limited', '超限返回 429 rate_limited');
serverB.close();
console.log(failures ? `\nFAIL=${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
