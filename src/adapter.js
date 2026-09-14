// adapter.js
// 知乎开放平台 API 适配层（可插拔）。
// 契约来源：知乎开放平台 HTTP API，字段归一集中在本适配层。
//   - 知乎搜索  GET https://developer.zhihu.com/api/v1/content/zhihu_search?Query=&Count=
//   - 全网搜索  GET .../api/v1/content/global_search?Query=&Count=&Filter=&SearchDB=
//   - 知乎热榜  GET .../api/v1/content/hot_list?Limit=
//   - 直答      POST https://developer.zhihu.com/v1/chat/completions  body {model,messages,stream}
//   - 鉴权      仅由同源服务端代理添加 Authorization + X-Request-Timestamp
//   - 响应包    {Code:0, Message:"success", Data:{Items:[...]}}（PascalCase 字段）
//   - 配额/日   hot 100 · search 5000 · 直答 100（以个人中心为准）
// 浏览器永不持有 Access Secret；默认 MockProvider，真实模式请求同源 /api/zhihu/*。

import { normalizeRecordFields, toNum } from './fields.js';

const CACHE_TTL_MS = 1000 * 60 * 60; // 1h 应用层缓存（配额保护）

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------- MockProvider（离线开发/演示，非真实数据） ----------
class MockProvider {
  constructor(topics, favorites = []) {
    this.topics = topics;
    this.favorites = favorites;
    this.quota = { used: 0, limit: 5000, exhausted: false };
    this.hotQuota = { used: 0, limit: 100, exhausted: false };
    this.daQuota = { used: 0, limit: 100, exhausted: false };
  }
  _tick(q) {
    q.used += 1;
    if (q.used >= q.limit) q.exhausted = true;
  }
  async search(query, { forceEmpty = false, signal } = {}) {
    await wait(280, signal);
    if (this.quota.exhausted) return { ok: true, empty: true, reason: 'quota_exhausted', items: [], quota: this.quota };
    this._tick(this.quota);
    if (forceEmpty) return { ok: true, empty: true, reason: 'no_result', items: [], quota: this.quota };
    const topic = this.topics.find((t) => t.query === query || t.id === query);
    if (!topic) return { ok: true, empty: true, reason: 'no_result', items: [], quota: this.quota };
    return { ok: true, empty: false, items: topic.items, query: topic.query, demo: Boolean(topic.demo), quota: this.quota };
  }
  // 模拟热榜：取预设话题标题（真实环境由 hot_list 返回）
  async hotList({ forceEmpty = false, signal } = {}) {
    await wait(200, signal);
    if (this.hotQuota.exhausted) return { ok: true, empty: true, reason: 'quota_exhausted', quota: this.hotQuota };
    this._tick(this.hotQuota);
    if (forceEmpty) return { ok: true, empty: true, reason: 'no_result', quota: this.hotQuota };
    return {
      ok: true,
      empty: false,
      items: this.topics.map((t) => ({ title: t.query, url: '', summary: t.items[0]?.excerpt || '', scenario: t.scenario?.label || '' })),
      quota: this.hotQuota,
    };
  }
  // 演示收藏夹列表（真实环境由 user-api favlists 拉取；OAuth 未部署时展示演示数据）
  async favoritesLists({ forceEmpty = false, signal } = {}) {
    await wait(200, signal);
    if (forceEmpty) return { ok: true, empty: true, reason: 'no_result', items: [], quota: this.quota };
    return {
      ok: true,
      empty: false,
      items: this.favorites.map((f) => ({ urlToken: String(f.urlToken), title: f.title, description: f.description })),
      demo: true,
      quota: this.quota,
    };
  }
  // 演示收藏夹内容（真实环境由 user-api favlist_contents 拉取）
  async favoritesItems(urlToken, { forceEmpty = false, signal } = {}) {
    await wait(280, signal);
    if (forceEmpty) return { ok: true, empty: true, reason: 'no_result', items: [], quota: this.quota };
    const f = this.favorites.find((x) => String(x.urlToken) === String(urlToken));
    if (!f) return { ok: true, empty: true, reason: 'no_result', items: [], quota: this.quota };
    return { ok: true, empty: false, items: f.items, title: f.title, demo: true, quota: this.quota };
  }
  async directAnswer(query, { forceEmpty = false, stream = false, onChunk = null, signal } = {}) {
    await wait(320, signal);
    if (this.daQuota.exhausted) return { ok: true, empty: true, reason: 'quota_exhausted', quota: this.daQuota };
    this._tick(this.daQuota);
    if (forceEmpty) return { ok: true, empty: true, reason: 'no_result', quota: this.daQuota };
    const topic = this.topics.find((t) => t.query === query || t.id === query);
    if (!topic || !topic.directAnswer) return { ok: true, empty: true, reason: 'no_result', quota: this.daQuota };
    // US-25 mock 流式：打字机效果模拟（明确标注 demo，非真实流式）
    if (stream && onChunk) {
      const text = topic.directAnswer.answer;
      for (let i = 0; i < text.length; i += 2) {
        onChunk(text.slice(i, i + 2));
        await wait(8, signal);
      }
      return { ok: true, empty: false, answer: text, citations: topic.directAnswer.citations, streamed: true, demo: true, query: topic.query, quota: this.daQuota };
    }
    return {
      ok: true,
      empty: false,
      answer: topic.directAnswer.answer,
      citations: topic.directAnswer.citations,
      query: topic.query,
      quota: this.daQuota,
    };
  }
  async classify() {
    return { ok: false, empty: true, reason: 'ai_cluster_disabled' };
  }
}

// ---------- HttpProvider（浏览器侧同源代理，不含任何凭证） ----------
class HttpProvider {
  constructor({
    proxyBase = '/api/zhihu',
    searchQuotaLimit = 5000,
    hotQuotaLimit = 100,
    daQuotaLimit = 100,
  } = {}) {
    this.proxyBase = proxyBase.replace(/\/$/, '');
    this.quota = { used: 0, limit: searchQuotaLimit, exhausted: false };
    this.hotQuota = { used: 0, limit: hotQuotaLimit, exhausted: false };
    this.daQuota = { used: 0, limit: daQuotaLimit, exhausted: false };
    this.cache = new Map();
    this.hotCache = new Map();
    this.daCache = new Map();
  }
  _notConfigured(q) {
    return { ok: false, empty: true, reason: 'not_configured', quota: q };
  }
  _oauthSessionRequired(q) {
    return { ok: false, empty: true, reason: 'oauth_session_required', quota: q };
  }
  _oauthSessionExpired(q) {
    return { ok: false, empty: true, reason: 'oauth_session_expired', quota: q };
  }
  _oauthNotConfigured(q) {
    return { ok: false, empty: true, reason: 'oauth_not_configured', quota: q };
  }
  _quotaHit(q) {
    q.exhausted = true;
    return { ok: true, empty: true, reason: 'quota_exhausted', quota: q };
  }
  _noResult(q) {
    return { ok: true, empty: true, reason: 'no_result', quota: q };
  }

  async search(query, { forceEmpty = false, count = 10, signal } = {}) {
    if (forceEmpty) return this._noResult(this.quota);
    const normalizedCount = Math.min(10, Math.max(1, Number(count) || 10));
    const cacheKey = `s:${query}:${normalizedCount}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    if (this.quota.exhausted) return this._quotaHit(this.quota);
    try {
      const url = `${this.proxyBase}/search?query=${encodeURIComponent(query)}&count=${normalizedCount}`;
      const resp = await fetch(url, { signal });
      this.quota.used += 1;
      const data = await resp.json().catch(() => null);
      if (resp.status === 429 || data?.Code === 30001 || data?.Code === 30002) return this._quotaHit(this.quota);
      if (resp.status === 503 && data?.reason === 'not_configured') return this._notConfigured(this.quota);
      if (resp.status === 502 || resp.status === 504 || data?.reason === 'network_error') return { ok: false, empty: true, reason: 'network_error', quota: this.quota };
      if (resp.status === 501 && data?.reason === 'oauth_session_required') return this._oauthSessionRequired(this.quota);
      if (!resp.ok || data?.Code !== 0) return { ok: false, empty: true, reason: 'api_error', quota: this.quota };
      const items = normalizeSearch(data.Data);
      const out = {
        ok: true,
        empty: items.length === 0,
        reason: items.length ? '' : 'no_result',
        items,
        query,
        quota: this.quota,
      };
      this.cache.set(cacheKey, { t: Date.now(), v: out });
      return out;
    } catch (e) {
      return { ok: false, empty: true, reason: 'network_error', quota: this.quota };
    }
  }

  async hotList({ forceEmpty = false, limit = 15, signal } = {}) {
    if (forceEmpty) return this._noResult(this.hotQuota);
    const normalizedLimit = Math.min(30, Math.max(1, Number(limit) || 15));
    const cacheKey = `hot:${normalizedLimit}`;
    const hit = this.hotCache.get(cacheKey);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    if (this.hotQuota.exhausted) return this._quotaHit(this.hotQuota);
    try {
      const url = `${this.proxyBase}/hot?limit=${normalizedLimit}`;
      const resp = await fetch(url, { signal });
      this.hotQuota.used += 1;
      const data = await resp.json().catch(() => null);
      if (resp.status === 429 || data?.Code === 30001 || data?.Code === 30002) return this._quotaHit(this.hotQuota);
      if (resp.status === 503 && data?.reason === 'not_configured') return this._notConfigured(this.hotQuota);
      if (resp.status === 502 || resp.status === 504 || data?.reason === 'network_error') return { ok: false, empty: true, reason: 'network_error', quota: this.hotQuota };
      if (!resp.ok || data?.Code !== 0) return { ok: false, empty: true, reason: 'api_error', quota: this.hotQuota };
      const items = normalizeHot(data.Data);
      const out = { ok: true, empty: items.length === 0, reason: items.length ? '' : 'no_result', items, quota: this.hotQuota };
      this.hotCache.set(cacheKey, { t: Date.now(), v: out });
      return out;
    } catch (e) {
      return { ok: false, empty: true, reason: 'network_error', quota: this.hotQuota };
    }
  }

  async directAnswer(query, { forceEmpty = false, stream = false, onChunk = null, signal } = {}) {
    if (forceEmpty) return this._noResult(this.daQuota);
    const cacheKey = `da:${query}`;
    // 流式结果不落入一次性缓存，也不能被一次性缓存短路。
    if (!stream) {
      const hit = this.daCache.get(cacheKey);
      if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    }
    if (this.daQuota.exhausted) return this._quotaHit(this.daQuota);
    try {
      // US-25 流式直答：stream=true 时 SSE 逐块回调（thinking 已在服务端脱敏），不落缓存
      if (stream) return this._directAnswerStream(query, onChunk, { signal });
      const resp = await fetch(`${this.proxyBase}/direct-answer`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
        }),
      });
      this.daQuota.used += 1;
      const data = await resp.json().catch(() => null);
      if (resp.status === 429 || data?.error?.code === 'rate_limit') return this._quotaHit(this.daQuota);
      if (resp.status === 503 && data?.reason === 'not_configured') return this._notConfigured(this.daQuota);
      if (resp.status === 502 || resp.status === 504 || data?.reason === 'network_error') return { ok: false, empty: true, reason: 'network_error', quota: this.daQuota };
      if (!resp.ok) return { ok: false, empty: true, reason: 'api_error', quota: this.daQuota };
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) return this._noResult(this.daQuota);
      const out = {
        ok: true,
        empty: false,
        answer: content,
        citations: [], // 直答 HTTP API 不返回结构化引用；mock 演示用引用，真实模式由正文承载
        query,
        quota: this.daQuota,
      };
      this.daCache.set(cacheKey, { t: Date.now(), v: out });
      return out;
    } catch (e) {
      return { ok: false, empty: true, reason: 'network_error', quota: this.daQuota };
    }
  }

  // 可选批量 AI 分组：一次话题最多 10 条，失败时由 app.js 回退确定性规则。
  async classify(items = [], { signal } = {}) {
    const rows = Array.isArray(items) ? items.filter((item) => item?.id && item?.excerpt).slice(0, 10) : [];
    if (!rows.length) return { ok: false, empty: true, reason: 'invalid_request', quota: this.daQuota };
    const cacheKey = `ac:${rows.map((item) => `${String(item.id)}:${String(item.excerpt).slice(0, 900)}`).join('|')}`;
    const hit = this.daCache.get(cacheKey);
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
    if (this.daQuota.exhausted) return this._quotaHit(this.daQuota);
    try {
      const resp = await fetch(`${this.proxyBase}/classify`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: rows.map((item) => ({ id: String(item.id), excerpt: String(item.excerpt).slice(0, 900) })) }),
      });
      this.daQuota.used += 1;
      const data = await resp.json().catch(() => null);
      if (resp.status === 429) return this._quotaHit(this.daQuota);
      if (resp.status === 503 && data?.reason === 'ai_cluster_disabled') return { ok: false, empty: true, reason: 'ai_cluster_disabled', quota: this.daQuota };
      if (resp.status === 502 || resp.status === 504 || data?.reason === 'network_error') return { ok: false, empty: true, reason: 'network_error', quota: this.daQuota };
      if (!resp.ok || data?.ok !== true || !Array.isArray(data.items)) return { ok: false, empty: true, reason: 'ai_cluster_unavailable', quota: this.daQuota };
      const out = { ok: true, empty: false, items: data.items, quota: this.daQuota };
      this.daCache.set(cacheKey, { t: Date.now(), v: out });
      return out;
    } catch {
      return { ok: false, empty: true, reason: 'network_error', quota: this.daQuota };
    }
  }

  // US-25 流式直答：SSE 逐块解析，onChunk(text) 收到正文增量；thinking 服务端已剥离
  async _directAnswerStream(query, onChunk, { signal } = {}) {
    if (this.daQuota.exhausted) return this._quotaHit(this.daQuota);
    try {
      const resp = await fetch(`${this.proxyBase}/direct-answer`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, stream: true }),
      });
      this.daQuota.used += 1;
      if (resp.status === 503) {
        const data = await resp.json().catch(() => null);
        if (data?.reason === 'not_configured') return this._notConfigured(this.daQuota);
      }
      if (resp.status === 429) return this._quotaHit(this.daQuota);
      if (resp.status === 502 || resp.status === 504) return { ok: false, empty: true, reason: 'network_error', quota: this.daQuota };
      if (!resp.ok || !resp.body) return { ok: false, empty: true, reason: 'api_error', quota: this.daQuota };
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let answer = '';
      const done = () => ({ ok: true, empty: !answer, answer, citations: [], streamed: true, query, quota: this.daQuota });
      const processLine = (rawLine) => {
        const line = String(rawLine).trim();
        if (!line.startsWith('data:')) return false;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return 'done';
        let parsed;
        try { parsed = JSON.parse(payload); } catch { return false; }
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          answer += delta;
          if (onChunk) onChunk(delta);
        }
        return false;
      };
      const abortReader = () => { reader.cancel?.().catch?.(() => {}); };
      signal?.addEventListener('abort', abortReader, { once: true });
      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          // 按行解析 SSE（单次解码可能跨块，缓冲处理）
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const result = processLine(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 1);
            if (result === 'done') return done();
          }
        }
        // reader EOF 仍可能留下没有换行的最后一帧，必须先 flush UTF-8 和 buffer。
        buffer += decoder.decode();
        if (buffer.trim() && processLine(buffer) === 'done') return done();
        return done();
      } finally {
        signal?.removeEventListener('abort', abortReader);
      }
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return { ok: false, empty: true, reason: 'aborted', quota: this.daQuota };
      return { ok: false, empty: true, reason: 'network_error', quota: this.daQuota };
    }
  }

  // 收藏夹列表（B1：经同源代理调 user-api，凭证仅服务端）
  async favoritesLists() {
    try {
      const resp = await fetch(`${this.proxyBase}/me/favlists`);
      const data = await resp.json().catch(() => null);
      if (resp.status === 503 && ['not_configured', 'oauth_not_configured'].includes(data?.reason)) return this._oauthNotConfigured(this.quota);
      if (resp.status === 401 && ['oauth_session_required', 'oauth_session_expired'].includes(data?.reason)) return data.reason === 'oauth_session_expired' ? this._oauthSessionExpired(this.quota) : this._oauthSessionRequired(this.quota);
      if (resp.status === 501 && data?.reason === 'oauth_session_required') return this._oauthSessionRequired(this.quota);
      if (!resp.ok || data?.Code !== 0) return { ok: false, empty: true, reason: 'api_error', quota: this.quota };
      const items = normalizeFavlists(data.Data);
      return { ok: true, empty: items.length === 0, reason: items.length ? '' : 'no_result', items, quota: this.quota };
    } catch (e) {
      return { ok: false, empty: true, reason: 'network_error', quota: this.quota };
    }
  }

  // 收藏夹内容（同源代理调 user-api favlist_contents）
  async favoritesItems(urlToken, { signal } = {}) {
    try {
      const resp = await fetch(`${this.proxyBase}/me/favlist-contents?FavlistUrlToken=${encodeURIComponent(urlToken)}`, { signal });
      const data = await resp.json().catch(() => null);
      if (resp.status === 503 && ['not_configured', 'oauth_not_configured'].includes(data?.reason)) return this._oauthNotConfigured(this.quota);
      if (resp.status === 401 && ['oauth_session_required', 'oauth_session_expired'].includes(data?.reason)) return data.reason === 'oauth_session_expired' ? this._oauthSessionExpired(this.quota) : this._oauthSessionRequired(this.quota);
      if (resp.status === 501 && data?.reason === 'oauth_session_required') return this._oauthSessionRequired(this.quota);
      if (!resp.ok || data?.Code !== 0) return { ok: false, empty: true, reason: 'api_error', quota: this.quota };
      const items = normalizeFavlistContents(data.Data);
      return { ok: true, empty: items.length === 0, reason: items.length ? '' : 'no_result', items, quota: this.quota };
    } catch (e) {
      return { ok: false, empty: true, reason: 'network_error', quota: this.quota };
    }
  }
}

// ---------- 归一化：官方 PascalCase → 应用统一 camelCase ----------
function stripEm(s) {
  return String(s || '').replace(/<[^>]+>/g, '');
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function clampAuthority(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 1;
  return Math.min(5, Math.max(1, Math.floor(n)));
}

export function normalizeSearch(d) {
  return (d?.Items || []).map((it) => {
    const normalized = normalizeRecordFields(it) || {};
    return {
      ...normalized,
      id: normalized.id || '',
      title: normalized.title || '',
      excerpt: stripEm(normalized.excerpt || ''),
      author: normalized.author || '知乎用户',
      // EditTime 是 Unix 秒；fields.js 只负责字段名归一，这里保留原有的日期展示契约。
      publishTime: it.EditTime ? fmtTime(it.EditTime) : normalized.publishTime || '',
      relevanceScore: toNum(it.RankingScore),
      authorityLevel: clampAuthority(normalized.authorityLevel || it.AuthorityLevel),
      voteupCount: toNum(normalized.voteupCount),
      commentCount: toNum(normalized.commentCount),
      featuredComment: (it.CommentInfoList || [])[0]?.Content || '',
      url: normalized.url || '',
      contentType: normalized.contentType || '',
    };
  });
}

export function normalizeHot(d) {
  return (d?.Items || []).map((it) => {
    const normalized = normalizeRecordFields(it) || {};
    return {
      ...normalized,
      title: normalized.title || '',
      url: normalized.url || '',
      summary: it.Summary || normalized.excerpt || '',
      thumbnailUrl: it.ThumbnailUrl || '',
    };
  });
}

// user-api 归一化（收藏夹列表 / 收藏夹内容）。
export function normalizeFavlists(d) {
  return (d?.Items || []).map((it) => {
    const normalized = normalizeRecordFields(it) || {};
    return {
      ...normalized,
      urlToken: String(it.UrlToken ?? it.url_token ?? ''),
      title: normalized.title || '',
      description: it.Description || '',
    };
  });
}

export function normalizeFavlistContents(d) {
  return (d?.Items || []).map((it) => {
    const normalized = normalizeRecordFields({
      ...it,
      AuthorName: it.Author?.Name,
      Excerpt: it.Summary,
      PublishTime: it.FavTime || it.CreatedAt,
      VoteCount: it.LikeCount,
    }) || {};
    return {
      ...normalized,
      id: normalized.id || it.Url || it.Title || '',
      title: normalized.title || '',
      excerpt: normalized.excerpt || '',
      author: normalized.author || '知乎用户',
      publishTime: normalized.publishTime ? fmtTime(normalized.publishTime) : '',
      relevanceScore: 0,
      authorityLevel: normalized.authorityLevel || 1, // user-api 无权威度字段，默认普通用户
      voteupCount: toNum(normalized.voteupCount),
      commentCount: toNum(normalized.commentCount),
      featuredComment: '',
      url: normalized.url || '',
      contentType: normalized.contentType || '',
    };
  });
}

export function createAdapter({ mode = 'mock', topics = [], favorites = [], httpConfig = {} } = {}) {
  return mode === 'http' || mode === 'cli' ? new HttpProvider(httpConfig) : new MockProvider(topics, favorites);
}
