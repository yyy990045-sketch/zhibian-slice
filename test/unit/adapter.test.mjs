import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, normalizeFavlistContents, normalizeFavlists, normalizeHot, normalizeSearch } from '../../src/adapter.js';

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function rawSearchItems(count) {
  return Array.from({ length: count }, (_, index) => ({
    ContentID: `item-${index}`,
    Title: `标题 ${index}`,
    ContentText: `正文 ${index}`,
    AuthorName: `作者 ${index}`,
    EditTime: 1_700_000_000,
    RankingScore: '0.8',
    AuthorityLevel: '4',
    VoteUpCount: '1.2万',
    CommentCount: '3,456',
    Url: `https://www.zhihu.com/question/42/answer/${index}`,
  }));
}

test('HttpProvider 搜索缓存键区分 count', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const count = Number(new URL(url, 'http://localhost').searchParams.get('count'));
    return jsonResponse({ Code: 0, Data: { Items: rawSearchItems(count) } });
  };
  const adapter = createAdapter({ mode: 'http' });
  const first = await adapter.search('同一个问题', { count: 1 });
  const second = await adapter.search('同一个问题', { count: 10 });
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 10);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /count=1/);
  assert.match(urls[1], /count=10/);
});

test('HttpProvider 热榜缓存键区分 limit', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const limit = Number(new URL(url, 'http://localhost').searchParams.get('limit'));
    return jsonResponse({ Code: 0, Data: { Items: Array.from({ length: limit }, (_, i) => ({ Title: `热榜 ${i}` })) } });
  };
  const adapter = createAdapter({ mode: 'http' });
  assert.equal((await adapter.hotList({ limit: 5 })).items.length, 5);
  assert.equal((await adapter.hotList({ limit: 30 })).items.length, 30);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /limit=5/);
  assert.match(urls[1], /limit=30/);
});

test('HttpProvider AI 分类缓存键包含正文', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return jsonResponse({ ok: true, items: [{ id: 'a', cluster: 'support' }] });
  };
  const adapter = createAdapter({ mode: 'http' });
  await adapter.classify([{ id: 'a', excerpt: '第一版正文' }]);
  await adapter.classify([{ id: 'a', excerpt: '第二版正文' }]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].items[0].excerpt, '第一版正文');
  assert.equal(bodies[1].items[0].excerpt, '第二版正文');
});

test('HttpProvider AI 分类额度耗尽后仍可读取已有缓存', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ ok: true, items: [{ id: 'cached', cluster: 'support' }] });
  };
  const adapter = createAdapter({ mode: 'http' });
  const input = [{ id: 'cached', excerpt: '已缓存正文' }];
  const first = await adapter.classify(input);
  adapter.daQuota.exhausted = true;
  const second = await adapter.classify(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.items, first.items);
  assert.equal(calls, 1);
});

test('MockProvider 响应搜索和直答取消信号', async () => {
  const adapter = createAdapter({
    mode: 'mock',
    topics: [{ query: '取消测试', items: [], directAnswer: { answer: '不会写入页面' } }],
  });
  const searchController = new AbortController();
  const search = adapter.search('取消测试', { signal: searchController.signal });
  searchController.abort();
  await assert.rejects(search, /aborted/i);

  const directController = new AbortController();
  const direct = adapter.directAnswer('取消测试', { stream: true, signal: directController.signal, onChunk() {} });
  directController.abort();
  await assert.rejects(direct, /aborted/i);
});

test('HttpProvider 流式直答在 EOF 时 flush 没有换行的最后一帧', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const frame = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Last"}}]}');
  let read = false;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: frame };
          },
          cancel() { return Promise.resolve(); },
        };
      },
    },
  });
  const chunks = [];
  const adapter = createAdapter({ mode: 'http' });
  const result = await adapter.directAnswer('EOF 测试', { stream: true, onChunk: (chunk) => chunks.push(chunk) });
  assert.equal(result.ok, true);
  assert.equal(result.answer, 'Last');
  assert.deepEqual(chunks, ['Last']);
});

test('真实字段归一入口覆盖数字别名与收藏夹字段', () => {
  const [search] = normalizeSearch({ Items: rawSearchItems(1) });
  assert.equal(search.voteupCount, 12000);
  assert.equal(search.commentCount, 3456);
  assert.equal(search.authorityLevel, 4);
  const [favorite] = normalizeFavlistContents({ Items: [{ Url: 'https://www.zhihu.com/question/42', Summary: '收藏正文', Author: { Name: '收藏作者' }, LikeCount: '2.1万', CreatedAt: 1_700_000_000 }] });
  assert.equal(favorite.excerpt, '收藏正文');
  assert.equal(favorite.author, '收藏作者');
  assert.equal(favorite.voteupCount, 21000);
});

test('MockProvider 覆盖空结果、热榜、收藏夹与流式直答', async () => {
  const topic = { query: '完整 Mock', items: [{ id: 'm1' }], directAnswer: { answer: 'Mock 答案', citations: [{ url: 'https://www.zhihu.com/question/1' }] } };
  const adapter = createAdapter({ mode: 'mock', topics: [topic], favorites: [{ urlToken: '7', title: '收藏', description: '说明', items: [{ id: 'f1' }] }] });

  assert.equal((await adapter.search('不存在')).reason, 'no_result');
  assert.equal((await adapter.search('完整 Mock', { forceEmpty: true })).reason, 'no_result');
  assert.equal((await adapter.hotList()).items[0].title, '完整 Mock');
  assert.equal((await adapter.hotList({ forceEmpty: true })).reason, 'no_result');
  assert.equal((await adapter.favoritesLists()).items[0].urlToken, '7');
  assert.equal((await adapter.favoritesLists({ forceEmpty: true })).reason, 'no_result');
  assert.equal((await adapter.favoritesItems('missing')).reason, 'no_result');
  assert.equal((await adapter.favoritesItems('7')).items[0].id, 'f1');
  assert.equal((await adapter.directAnswer('完整 Mock', { forceEmpty: true })).reason, 'no_result');
  assert.equal((await adapter.directAnswer('不存在')).reason, 'no_result');
  const chunks = [];
  const streamed = await adapter.directAnswer('完整 Mock', { stream: true, onChunk: (chunk) => chunks.push(chunk) });
  assert.equal(streamed.streamed, true);
  assert.equal(chunks.join(''), 'Mock 答案');
  assert.equal((await adapter.classify([{ id: 'm1', excerpt: 'Mock 正文' }])).reason, 'ai_cluster_disabled');
});

test('HttpProvider 错误分支和收藏夹接口保持明确降级', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const invoke = async (response, operation) => {
    globalThis.fetch = async () => response;
    return operation(createAdapter({ mode: 'http' }));
  };
  assert.equal((await invoke(jsonResponse({}, 429), (adapter) => adapter.search('q-429'))).reason, 'quota_exhausted');
  assert.equal((await invoke(jsonResponse({ reason: 'not_configured' }, 503), (adapter) => adapter.search('q-503'))).reason, 'not_configured');
  assert.equal((await invoke(jsonResponse({}, 502), (adapter) => adapter.search('q-502'))).reason, 'network_error');
  assert.equal((await invoke(jsonResponse({ reason: 'oauth_session_required' }, 501), (adapter) => adapter.search('q-501'))).reason, 'oauth_session_required');
  assert.equal((await invoke(jsonResponse({ Code: 99 }, 200), (adapter) => adapter.search('q-api'))).reason, 'api_error');
  assert.equal((await invoke(jsonResponse({}, 429), (adapter) => adapter.hotList({ limit: 1 }))).reason, 'quota_exhausted');
  assert.equal((await invoke(jsonResponse({ reason: 'not_configured' }, 503), (adapter) => adapter.hotList({ limit: 2 }))).reason, 'not_configured');
  assert.equal((await invoke(jsonResponse({}, 502), (adapter) => adapter.hotList({ limit: 3 }))).reason, 'network_error');
  assert.equal((await invoke(jsonResponse({ Code: 99 }, 200), (adapter) => adapter.hotList({ limit: 4 }))).reason, 'api_error');
  assert.equal((await invoke(jsonResponse({ reason: 'not_configured' }, 503), (adapter) => adapter.directAnswer('da-503'))).reason, 'not_configured');
  assert.equal((await invoke(jsonResponse({}, 429), (adapter) => adapter.directAnswer('da-429'))).reason, 'quota_exhausted');
  assert.equal((await invoke(jsonResponse({}, 502), (adapter) => adapter.directAnswer('da-502'))).reason, 'network_error');
  assert.equal((await invoke(jsonResponse({}, 500), (adapter) => adapter.directAnswer('da-500'))).reason, 'api_error');
  assert.equal((await invoke(jsonResponse({ reason: 'ai_cluster_disabled' }, 503), (adapter) => adapter.classify([{ id: 'x', excerpt: 'x' }]))).reason, 'ai_cluster_disabled');
  assert.equal((await invoke(jsonResponse({ reason: 'oauth_session_required' }, 501), (adapter) => adapter.favoritesLists())).reason, 'oauth_session_required');
  assert.equal((await invoke(jsonResponse({ Code: 99 }, 200), (adapter) => adapter.favoritesLists())).reason, 'api_error');
  assert.equal((await invoke(jsonResponse({ reason: 'not_configured' }, 503), (adapter) => adapter.favoritesItems('token'))).reason, 'oauth_not_configured');
  assert.equal((await invoke(jsonResponse({ reason: 'oauth_session_required' }, 501), (adapter) => adapter.favoritesItems('token'))).reason, 'oauth_session_required');
  assert.equal((await invoke(jsonResponse({ Code: 99 }, 200), (adapter) => adapter.favoritesItems('token'))).reason, 'api_error');
});

test('HttpProvider 处理异常响应、空内容、批量分类与请求异常', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const queue = [
    { status: 200, ok: true, json: async () => ({ Code: 0, Data: { Items: [] } }) },
    { status: 200, ok: true, json: async () => ({ Code: 0, Data: { Items: [] } }) },
    { status: 200, ok: true, json: async () => ({ choices: [] }) },
    { status: 200, ok: true, json: async () => ({ ok: false, items: [] }) },
    { status: 500, ok: false, json: async () => ({}) },
  ];
  globalThis.fetch = async () => queue.shift() || Promise.reject(new Error('offline'));
  const adapter = createAdapter({ mode: 'http' });
  assert.equal((await adapter.search('empty', { forceEmpty: true })).reason, 'no_result');
  assert.equal((await adapter.search('empty')).reason, 'no_result');
  assert.equal((await adapter.hotList({ forceEmpty: true })).reason, 'no_result');
  assert.equal((await adapter.hotList()).reason, 'no_result');
  assert.equal((await adapter.directAnswer('blank')).reason, 'no_result');
  assert.equal((await adapter.classify([{ id: 'x', excerpt: 'x' }])).reason, 'ai_cluster_unavailable');
  adapter.daQuota.exhausted = true;
  assert.equal((await adapter.classify([{ id: 'y', excerpt: 'y' }])).reason, 'quota_exhausted');
  adapter.daQuota.exhausted = false;
  assert.equal((await adapter.directAnswer('offline')).reason, 'api_error');
  assert.equal((await createAdapter({ mode: 'http' }).search('network')).reason, 'network_error');
});

test('归一化入口覆盖热榜、收藏夹空值和字段兜底', () => {
  const [hot] = normalizeHot({ Items: [{ Title: '热榜标题', Summary: '摘要', ThumbnailUrl: 'https://img.example/x' }] });
  assert.equal(hot.title, '热榜标题');
  assert.equal(hot.summary, '摘要');
  assert.equal(hot.thumbnailUrl, 'https://img.example/x');
  const [fav] = normalizeFavlists({ Items: [{ url_token: 'legacy', Title: '旧收藏', Description: '描述' }] });
  assert.equal(fav.urlToken, 'legacy');
  assert.equal(fav.description, '描述');
  assert.deepEqual(normalizeHot(null), []);
  assert.deepEqual(normalizeFavlists(null), []);
  assert.deepEqual(normalizeFavlistContents(null), []);
});
