// 安全回归：浏览器只请求同源代理；仅服务端向知乎附加鉴权头。
import { createAdapter } from './src/adapter.js';
import { createZhihuProxy } from './server.mjs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const ok = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`);
  if (!condition) failures += 1;
};

const clientCalls = [];
globalThis.fetch = async (url, init = {}) => {
  clientCalls.push({ url: String(url), init });
  if (String(url).includes('/search')) return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) };
  if (String(url).includes('/hot')) return { ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) };
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '测试直答' } }] }) };
};
const browser = createAdapter({ mode: 'http' });
await browser.search('立场校准');
await browser.hotList();
await browser.directAnswer('立场校准');
ok(clientCalls.every(({ url }) => url.startsWith('/api/zhihu/')), '浏览器仅调用同源 /api/zhihu/*');
ok(clientCalls.every(({ init }) => !Object.keys(init.headers || {}).some((name) => /authorization|timestamp/i.test(name))), '浏览器请求不含 Authorization 或 X-Request-Timestamp');
ok(!JSON.stringify(clientCalls).includes('secret'), '浏览器请求不含 Secret');

const upstreamCalls = [];
const proxy = createZhihuProxy({
  accessSecret: 'fixture-access-value',
  fetchImpl: async (url, init) => {
    upstreamCalls.push({ url, init });
    const answer = String(url).includes('/chat/completions')
      ? { choices: [{ message: { content: '服务端直答' } }] }
      : { Code: 0, Data: { Items: [] } };
    return { ok: true, status: 200, json: async () => answer };
  },
});
const params = new URLSearchParams({ query: '立场校准', count: '99' });
await proxy('GET', '/api/zhihu/search', params);
await proxy('GET', '/api/zhihu/hot', new URLSearchParams({ limit: '99' }));
await proxy('POST', '/api/zhihu/direct-answer', new URLSearchParams(), { query: '立场校准' });
ok(upstreamCalls.length === 3, '服务端代理转发三类允许的官方接口');
ok(upstreamCalls[0].url.includes('Query=%E7%AB%8B%E5%9C%BA%E6%A0%A1%E5%87%86&Count=10'), '搜索参数由服务端限幅到 Count=10');
ok(upstreamCalls[1].url.endsWith('hot_list?Limit=30'), '热榜参数由服务端限幅到 Limit=30');
ok(upstreamCalls.every(({ init }) => init.headers.Authorization === 'Bearer fixture-access-value'), '仅服务端上游请求携带 Access Secret');
ok(upstreamCalls.every(({ init }) => /^\d+$/.test(init.headers['X-Request-Timestamp'])), '仅服务端生成秒级时间戳');
ok(JSON.parse(upstreamCalls[2].init.body).model === 'zhida-thinking-1p5', '服务端固定直答模型，浏览器不可注入模型参数');

const absent = createZhihuProxy({ accessSecret: '' });
const unavailable = await absent('GET', '/api/zhihu/search', new URLSearchParams({ query: 'x' }));
ok(unavailable.status === 503 && unavailable.body.reason === 'not_configured', '未配置密钥时代理明确降级');
const blocked = await proxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'x' }), undefined, 'https://evil.example');
ok(blocked.status === 403 && blocked.body.error === 'origin_not_allowed', '不在白名单的 Origin 被拒绝');
const productionProxy = createZhihuProxy({
  accessSecret: 'fixture-access-value',
  allowedOrigins: ['https://app.example'],
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) }),
});
const allowed = await productionProxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'x' }), undefined, 'https://app.example');
ok(allowed.status === 200, '显式白名单中的生产 Origin 可访问代理');
const publicAsset = await productionProxy('GET', '/styles.css', new URLSearchParams(), undefined, 'https://evil.example');
ok(publicAsset === null, '静态资源不进入 API Origin 校验');
const upstreamBeforeUserApi = upstreamCalls.length;
const userApi = await proxy('GET', '/api/zhihu/me/favlists', new URLSearchParams());
ok(userApi.status === 501 && userApi.body.reason === 'oauth_session_required', '通用代理不处理用户数据；只能由 OAuth 会话层读取');
ok(upstreamCalls.length === upstreamBeforeUserApi, '通用代理拒绝用户数据时不发起上游请求或消耗额度');

// CLI 模式的 AI 分组必须走官方 CLI，不得回退到没有凭证的 HTTP 请求。
const cliDir = await mkdtemp(join(tmpdir(), 'zhibian-cli-'));
const fakeCli = join(cliDir, 'zhihu-cli');
await writeFile(fakeCli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'answer') process.exit(2);
if (!args.includes('--timeout')) process.exit(3);
const content = JSON.stringify([{ id: 'a1', cluster: 'conditional', stance: 'support', conditionality: 'conditional', condition: '取决于前提', evidenceType: 'unclear', evidenceExcerpt: '前提', confidence: 0.7, needsHumanReview: false }]);
process.stdout.write(JSON.stringify({ choices: [{ message: { content } }] }));
`);
await chmod(fakeCli, 0o755);
try {
  process.env.ZHIBIAN_AI_CLUSTER = '1';
  const cliProxy = createZhihuProxy({ cliPath: fakeCli, accessSecret: '' });
  const cliClassified = await cliProxy('POST', '/api/zhihu/classify', new URLSearchParams(), { items: [{ id: 'a1', excerpt: '应该做，但取决于前提' }] });
  ok(cliClassified.status === 200 && cliClassified.body.items[0].cluster === 'conditional', 'CLI 模式批量 AI 分组走官方 answer JSON 能力');
  ok(cliProxy.stats().upstreamCalls === 1 && cliProxy.stats().quota.directAnswer.used === 1, 'CLI 模式批量 AI 分组计入直答配额');
  const cliCached = await cliProxy('POST', '/api/zhihu/classify', new URLSearchParams(), { items: [{ id: 'a1', excerpt: '应该做，但取决于前提' }] });
  ok(cliCached.status === 200 && cliProxy.stats().upstreamCalls === 1 && cliProxy.stats().cacheHits === 1, 'CLI 模式批量 AI 分组命中服务端缓存');
} finally {
  delete process.env.ZHIBIAN_AI_CLUSTER;
  await rm(cliDir, { recursive: true, force: true });
}
console.log(failures ? `\nFAIL=${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
