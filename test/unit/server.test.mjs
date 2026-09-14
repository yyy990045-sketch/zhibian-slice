import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  createAppServer,
  createZhihuProxy,
  getClientIp,
  streamDirectAnswer,
  streamZhihuCli,
  validateEnv,
} from '../../server.mjs';

test('validateEnv 不重复报告 HTTP 缺失 Secret', () => {
  assert.deepEqual(validateEnv({ production: true, provider: 'http', allowedOrigins: ['http://localhost'], accessSecret: '' }), ['ZHIHU_ACCESS_SECRET']);
});

test('启用 OAuth 的生产启动门禁要求三项 OAuth 配置', () => {
  assert.deepEqual(
    validateEnv({ production: true, provider: 'http', allowedOrigins: ['https://app.example'], accessSecret: 'fixture-access-value', oauthRequired: true }),
    ['ZHIHU_OAUTH_APP_ID', 'ZHIHU_OAUTH_APP_KEY', 'ZHIHU_OAUTH_REDIRECT_URI'],
  );
});

test('显式 mock provider 不会因误传 Secret 而调用 HTTP 上游', async (t) => {
  const upstreamCalls = [];
  const server = createAppServer({
    provider: 'mock',
    accessSecret: 'fixture-unused-value',
    fetchImpl: async (url) => {
      upstreamCalls.push(url);
      return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/zhihu/search?query=provider-isolation`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.reason, 'not_configured');
  assert.equal(upstreamCalls.length, 0);
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.provider, 'mock');
});

test('代理达到配额上限后返回 429 且不再调用上游', async () => {
  let upstreamCalls = 0;
  const proxy = (await import('../../server.mjs')).createZhihuProxy({
    provider: 'http',
    accessSecret: 'fixture-access-value',
    quotaLimits: { search: 1, hot: 1, directAnswer: 1 },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) };
    },
  });
  const first = await proxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'first' }));
  const second = await proxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'second' }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.body.reason, 'quota_exhausted');
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(proxy.stats().quota.search, { used: 1, limit: 1 });
});

test('代理并发同键请求只调用一次上游并共享结果', async () => {
  let upstreamCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const proxy = createZhihuProxy({
    provider: 'http',
    accessSecret: 'fixture-access-value',
    quotaLimits: { search: 1 },
    fetchImpl: async () => {
      upstreamCalls += 1;
      await gate;
      return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) };
    },
  });
  const first = proxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'same-key' }));
  const second = proxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'same-key' }));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(proxy.stats().quota.search, { used: 1, limit: 1 });
});

test('直答配额达到上限后流式与非流式都不再调用上游', async () => {
  let upstreamCalls = 0;
  const proxy = createZhihuProxy({
    provider: 'http',
    accessSecret: 'fixture-access-value',
    quotaLimits: { directAnswer: 1 },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'answer' } }] }) };
    },
  });
  const first = await proxy('POST', '/api/zhihu/direct-answer', new URLSearchParams(), { query: 'first', stream: false });
  const second = await proxy('POST', '/api/zhihu/direct-answer', new URLSearchParams(), { query: 'second', stream: false });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.body.reason, 'quota_exhausted');
  assert.equal(upstreamCalls, 1);
});

test('流式直答使用调用方超时并返回稳定的超时响应', async () => {
  const stats = { quota: { directAnswer: { used: 0 } }, upstreamCalls: 0, errors: 0 };
  const result = await streamDirectAnswer({
    accessSecret: 'fixture-access-value',
    timeoutMs: 5,
    stats,
    // AbortSignal.timeout 的内部计时器不持有事件循环：若 fetchImpl 只等待 abort，
    // 事件循环会先空转，node:test 会判定测试挂起并取消同文件后续用例。
    // 这里保留一个 ref'd 计时器维持事件循环，确保 abort 能真正触发。
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('test-keepalive-timeout')), 1000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(new Error('aborted'));
      }, { once: true });
    }),
  });
  assert.equal(result.status, 504);
  assert.equal(result.body.reason, 'upstream_timeout');
  assert.equal(stats.quota.directAnswer.used, 1);
});

test('生产环境不公开审计详情，配置令牌后只允许 Bearer 访问', async (t) => {
  const hidden = createAppServer({ provider: 'mock', production: true, allowedOrigins: ['http://localhost'], rateLimitMax: 100 });
  await new Promise((resolve) => hidden.listen(0, '127.0.0.1', resolve));
  t.after(() => hidden.close());
  const hiddenResponse = await fetch(`http://127.0.0.1:${hidden.address().port}/api/zhihu/audit`);
  assert.equal(hiddenResponse.status, 404);

  const protectedServer = createAppServer({ provider: 'mock', production: true, auditToken: 'audit-test-token', allowedOrigins: ['http://localhost'], rateLimitMax: 100 });
  await new Promise((resolve) => protectedServer.listen(0, '127.0.0.1', resolve));
  t.after(() => protectedServer.close());
  const base = `http://127.0.0.1:${protectedServer.address().port}/api/zhihu/audit`;
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers: { Authorization: 'Bearer audit-test-token' } })).status, 200);
});

test('默认不信任 X-Forwarded-For，显式配置后才读取', () => {
  const req = { socket: { remoteAddress: '10.0.0.7' }, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.7' } };
  assert.equal(getClientIp(req), '10.0.0.7');
  assert.equal(getClientIp(req, { trustProxy: true }), '203.0.113.9');
});

test('限流器每个请求只计一次', async () => {
  const { createRateLimiter } = await import('../../server.mjs');
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  assert.deepEqual(limiter.check('client'), { allowed: true, remaining: 1 });
  assert.deepEqual(limiter.check('client'), { allowed: true, remaining: 0 });
  assert.deepEqual(limiter.check('client'), { allowed: false, remaining: 0 });
  assert.equal(limiter._count('client'), 2);
});

test('CSRF refusal 计入 stats，POST body keys 进入 audit', async (t) => {
  const server = createAppServer({ provider: 'mock', allowedOrigins: ['http://localhost:4173'], rateLimitMax: 100 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const csrfResponse = await fetch(`${base}/api/zhihu/direct-answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '缺少 Origin' }),
  });
  assert.equal(csrfResponse.status, 400);
  const stats = await (await fetch(`${base}/api/zhihu/stats`)).json();
  assert.equal(stats.refusals, 1);

  const requestResponse = await fetch(`${base}/api/zhihu/direct-answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4173' },
    body: JSON.stringify({ query: '审计字段', stream: false }),
  });
  assert.equal(requestResponse.status, 503);
  const audit = await (await fetch(`${base}/api/zhihu/audit`)).json();
  const entry = audit.entries.find((item) => item.path === '/api/zhihu/direct-answer' && item.status === 503);
  assert.deepEqual(entry.bodyKeys.sort(), ['query', 'stream']);
});

test('静态文件只公开运行时资源，内部脚本和数据不对外提供', async (t) => {
  const server = createAppServer({ provider: 'mock', rateLimitMax: 100 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/src/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/assets/topic-cards/ai.webp`)).status, 200);
  assert.equal((await fetch(`${base}/data/holdout-cases.template.json`)).status, 404);
  assert.equal((await fetch(`${base}/scripts/annotate-holdout-web.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/README.md`)).status, 404);
});

test('OAuth 收藏夹校准只使用短会话，并将用户数据请求绑定到已列出的收藏夹', async (t) => {
  const upstreamCalls = [];
  const server = createAppServer({
    provider: 'http',
    accessSecret: 'fixture-access-value',
    oauthAppId: 'public-app-id',
    oauthAppKey: 'fixture-app-key',
    oauthRedirectUri: 'https://app.example/api/zhihu/oauth/callback',
    allowedOrigins: ['http://localhost'],
    rateLimitMax: 100,
    fetchImpl: async (url, init = {}) => {
      upstreamCalls.push({ url: String(url), init });
      if (String(url) === 'https://openapi.zhihu.com/access_token') {
        assert.match(String(init.body), /app_key=fixture-app-key/);
        assert.match(String(init.body), /code=callback-code/);
        return { ok: true, status: 200, json: async () => ({ access_token: 'fixture-oauth-token', expires_in: 60 }) };
      }
      if (String(url).includes('/api/v1/user/favlists')) {
        assert.equal(init.headers['X-OAuth-Token'], 'fixture-oauth-token');
        assert.equal(init.headers.Authorization, 'Bearer fixture-access-value');
        return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [{ UrlToken: '42', Title: '只读收藏夹', Description: '测试' }] } }) };
      }
      if (String(url).includes('/api/v1/user/favlist_contents')) {
        assert.equal(init.headers['X-OAuth-Token'], 'fixture-oauth-token');
        return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) };
      }
      throw new Error(`unexpected upstream request: ${url}`);
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const begin = await fetch(`${base}/api/zhihu/oauth/login`, { redirect: 'manual' });
  assert.equal(begin.status, 302);
  assert.match(begin.headers.get('location'), /^https:\/\/openapi\.zhihu\.com\/authorize\?/);
  assert.match(begin.headers.get('location'), /app_id=public-app-id/);
  assert.match(begin.headers.get('location'), /redirect_uri=https%3A%2F%2Fapp\.example%2Fapi%2Fzhihu%2Foauth%2Fcallback/);
  const preauthCookie = begin.headers.get('set-cookie').split(';', 1)[0];
  assert.match(begin.headers.get('set-cookie'), /HttpOnly/);
  assert.match(begin.headers.get('set-cookie'), /Secure/);

  const callback = await fetch(`${base}/api/zhihu/oauth/callback?authorization_code=callback-code`, {
    redirect: 'manual',
    headers: { Cookie: preauthCookie },
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/?oauth=connected');
  const sessionCookie = callback.headers.get('set-cookie').split(', ').find((value) => value.startsWith('zhibian_oauth_session=')).split(';', 1)[0];

  const lists = await fetch(`${base}/api/zhihu/me/favlists`, { headers: { Cookie: sessionCookie } });
  assert.equal(lists.status, 200);
  assert.equal((await lists.json()).Data.Items[0].UrlToken, '42');
  assert.equal(upstreamCalls.filter((call) => call.url.includes('/favlists')).length, 1);

  assert.equal((await fetch(`${base}/api/zhihu/me/favlist-contents?FavlistUrlToken=999`, { headers: { Cookie: sessionCookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/zhihu/me/favlist-contents?FavlistUrlToken=42`, { headers: { Cookie: sessionCookie } })).status, 200);

  const logout = await fetch(`${base}/api/zhihu/oauth/logout`, {
    method: 'POST',
    headers: { Cookie: sessionCookie, Origin: 'http://localhost' },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${base}/api/zhihu/me/favlists`, { headers: { Cookie: sessionCookie } })).status, 401);
});

test('HTTP 回调地址不写 Secure Cookie，避免明文入口丢掉 OAuth 预授权', async (t) => {
  const server = createAppServer({
    provider: 'http',
    accessSecret: 'fixture-access-value',
    oauthAppId: 'public-app-id',
    oauthAppKey: 'fixture-app-key',
    oauthRedirectUri: 'http://127.0.0.1:4173/api/zhihu/oauth/callback',
    rateLimitMax: 100,
    fetchImpl: async () => { throw new Error('must not call upstream'); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const begin = await fetch(`http://127.0.0.1:${server.address().port}/api/zhihu/oauth/login`, { redirect: 'manual' });
  assert.equal(begin.status, 302);
  assert.match(begin.headers.get('set-cookie'), /HttpOnly/);
  assert.doesNotMatch(begin.headers.get('set-cookie'), /Secure/);
});

test('OAuth 回调没有有效预授权 Cookie 时不换取令牌', async (t) => {
  let upstreamCalls = 0;
  const server = createAppServer({
    provider: 'http',
    accessSecret: 'fixture-access-value',
    oauthAppId: 'public-app-id',
    oauthAppKey: 'fixture-app-key',
    oauthRedirectUri: 'https://app.example/api/zhihu/oauth/callback',
    rateLimitMax: 100,
    fetchImpl: async () => { upstreamCalls += 1; throw new Error('must not call upstream'); },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/zhihu/oauth/callback?authorization_code=unexpected`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?oauth=failed');
  assert.equal(upstreamCalls, 0);
});

test('CLI stream 非零退出不会静默结束为空流', async () => {
  const child = {
    stdout: Readable.from([]),
    once(event, handler) {
      if (event === 'close') setImmediate(() => handler(1));
      return this;
    },
    kill() {},
  };
  const stream = streamZhihuCli('fake-cli', [], { spawnImpl: () => child, timeoutMs: 100 });
  await assert.rejects(async () => {
    for await (const _chunk of stream) { /* consume */ }
  }, /cli_error/);
});
