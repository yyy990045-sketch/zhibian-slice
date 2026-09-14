// Local/demo server and production-compatible same-origin Zhihu API proxy.
// Keep ZHIHU_ACCESS_SECRET in the server environment only; never add it to HTML or client JS.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonLog, sanitizePayload } from './src/logger.js';
import { createAuditLog } from './src/audit.js';
import { buildClusterPrompt, parseClusterResponse } from './src/ai-cluster.js';
import { DEFAULT_DIRECT_MODEL } from './src/providers.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const API_BASE = 'https://developer.zhihu.com';
const OAUTH_BASE = 'https://openapi.zhihu.com';
const CACHE_TTL_MS = 60 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const PUBLIC_FILE_NAMES = new Set(['index.html', 'styles.css']);
const PUBLIC_FILE_PREFIXES = ['src/', 'assets/'];

// 本地 Keychain 模式通过官方 CLI 读取凭据；绝不从 Keychain 导出或回显 Secret。
// 结构化观点分组的 prompt 比普通直答更长；CLI 默认等待时间不足时会在
// 模型仍处理中提前返回 cli_error，所以显式给 answer 60s，并留出进程收尾时间。
const DEFAULT_CLI_TIMEOUT_MS = 75_000;
const CLI_ANSWER_TIMEOUT = '60s';
const OAUTH_PREAUTH_COOKIE = 'zhibian_oauth_preauth';
const OAUTH_SESSION_COOKIE = 'zhibian_oauth_session';
const OAUTH_PREAUTH_TTL_MS = 10 * 60 * 1000;
const OAUTH_SESSION_MAX_MS = 60 * 60 * 1000;

function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { cookies.set(name, decodeURIComponent(value)); } catch { /* 非法 Cookie 视为缺失 */ }
  }
  return cookies;
}

function oauthCookie(name, value, { maxAge = 0, path = '/api/zhihu', secure = false } = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAge))}`];
  // Secure Cookie 只在 HTTPS 回调地址下启用；明文 HTTP 不应声明 Secure。
  if (secure) attributes.splice(3, 0, 'Secure');
  return attributes.join('; ');
}

function loadDotEnvFile(filePath, env = process.env) {
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (env[key] == null || env[key] === '') env[key] = value;
  }
}

/**
 * OAuth token 只活在当前 Node 进程内。Cookie 仅保存随机会话 ID；不会写 token、
 * 收藏夹内容或用户身份到浏览器、审计或磁盘。
 */
export function createOAuthSessionStore({
  fetchImpl = fetch,
  oauthBase = OAUTH_BASE,
  appId = '',
  appKey = '',
  redirectUri = '',
  now = () => Date.now(),
} = {}) {
  const preauthorizations = new Map();
  const sessions = new Map();
  const configured = () => Boolean(appId && appKey && redirectUri);
  const cleanExpired = () => {
    const timestamp = now();
    for (const [id, value] of preauthorizations) if (value.expiresAt <= timestamp) preauthorizations.delete(id);
    for (const [id, value] of sessions) if (value.expiresAt <= timestamp) sessions.delete(id);
  };
  const sessionFromCookie = (cookieHeader) => {
    cleanExpired();
    const id = parseCookies(cookieHeader).get(OAUTH_SESSION_COOKIE);
    return id ? { id, session: sessions.get(id) || null } : { id: '', session: null };
  };

  return {
    configured,
    begin() {
      cleanExpired();
      if (!configured()) return null;
      const id = randomUUID();
      preauthorizations.set(id, { expiresAt: now() + OAUTH_PREAUTH_TTL_MS });
      const authorize = new URL('/authorize', oauthBase);
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('app_id', appId);
      authorize.searchParams.set('response_type', 'code');
      return { authorizationUrl: authorize.toString(), preauthId: id, maxAge: OAUTH_PREAUTH_TTL_MS / 1000 };
    },
    async complete({ cookieHeader = '', authorizationCode = '' } = {}) {
      cleanExpired();
      const preauthId = parseCookies(cookieHeader).get(OAUTH_PREAUTH_COOKIE);
      const preauth = preauthId ? preauthorizations.get(preauthId) : null;
      if (!configured() || !preauth || !String(authorizationCode).trim()) return null;
      preauthorizations.delete(preauthId);
      try {
        const response = await fetchImpl(new URL('/access_token', oauthBase), {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            app_id: appId,
            app_key: appKey,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            code: String(authorizationCode).trim(),
          }).toString(),
        });
        const body = await response.json().catch(() => null);
        const oauthToken = String(body?.access_token || '');
        if (!response.ok || !oauthToken) return null;
        const expiresIn = Number(body?.expires_in);
        const sessionMs = Number.isFinite(expiresIn)
          ? Math.min(OAUTH_SESSION_MAX_MS, Math.max(60_000, expiresIn * 1000))
          : OAUTH_SESSION_MAX_MS;
        const id = randomUUID();
        sessions.set(id, { oauthToken, expiresAt: now() + sessionMs, allowedFavlistTokens: new Set() });
        return { sessionId: id, maxAge: Math.floor(sessionMs / 1000) };
      } catch {
        return null;
      }
    },
    get(cookieHeader) {
      return sessionFromCookie(cookieHeader);
    },
    rememberFavlists(session, rows = []) {
      session.allowedFavlistTokens = new Set((rows || []).map((item) => String(item?.UrlToken ?? item?.url_token ?? '')).filter((value) => /^\d+$/.test(value)));
    },
    allowsFavlist(session, token) {
      return Boolean(session?.allowedFavlistTokens?.has(String(token)));
    },
    logout(cookieHeader) {
      const { id } = sessionFromCookie(cookieHeader);
      if (id) sessions.delete(id);
    },
  };
}

function runZhihuCli(cliPath, args, { timeoutMs = DEFAULT_CLI_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    } catch {
      resolve({ ok: false, status: 503, error: 'cli_unavailable' });
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, status: 504, error: 'cli_timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); finish({ ok: false, status: 503, error: 'cli_unavailable' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) return finish({ ok: false, status: 502, error: 'cli_error' });
      try { finish({ ok: true, status: 200, body: JSON.parse(stdout) }); }
      catch { finish({ ok: false, status: 502, error: 'cli_invalid_json' }); }
    });
  });
}

function cliStreamError(status, reason) {
  const error = new Error(reason);
  error.statusCode = status;
  error.reason = reason;
  return error;
}

export function streamZhihuCli(cliPath, args, { timeoutMs = DEFAULT_CLI_TIMEOUT_MS, spawnImpl = spawn, onError = () => {} } = {}) {
  let child;
  try {
    child = spawnImpl(cliPath, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } });
  } catch {
    const error = cliStreamError(503, 'cli_unavailable');
    onError(error);
    return (async function* () { throw error; })();
  }

  let outcome;
  let resolveOutcome;
  let reported = false;
  const outcomePromise = new Promise((resolve) => { resolveOutcome = resolve; });
  const settle = (value) => {
    if (!outcome) { outcome = value; resolveOutcome(value); }
  };
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* 子进程可能已退出 */ }
    settle({ status: 504, reason: 'cli_timeout' });
  }, timeoutMs);
  child.once('error', () => settle({ status: 503, reason: 'cli_unavailable' }));
  child.once('close', (code) => settle({ code }));

  const reportError = (error) => {
    if (!reported) { reported = true; onError(error); }
  };
  return (async function* () {
    let emitted = false;
    try {
      for await (const chunk of child.stdout) {
        emitted = true;
        yield chunk;
      }
      const result = await outcomePromise;
      if (result.status) throw cliStreamError(result.status, result.reason);
      if (result.code !== 0) throw cliStreamError(502, 'cli_error');
      if (!emitted) throw cliStreamError(502, 'cli_empty_stream');
    } catch (error) {
      reportError(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
}

const intInRange = (value, fallback, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

function resolveProvider(requested = '', { accessSecret = '', cliPath = '' } = {}) {
  if (['mock', 'http', 'cli'].includes(requested)) return requested;
  const envProvider = process.env.ZHIBIAN_PROVIDER;
  if (['mock', 'http', 'cli'].includes(envProvider)) return envProvider;
  return cliPath && !accessSecret ? 'cli' : accessSecret ? 'http' : 'mock';
}

export function createZhihuProxy({ fetchImpl = fetch, spawnImpl = spawn, accessSecret = process.env.ZHIHU_ACCESS_SECRET || '', cliPath = process.env.ZHIHU_CLI_PATH || '', apiBase = API_BASE, upstreamTimeoutMs = 20_000, allowedOrigins = (process.env.ZHIBIAN_ALLOWED_ORIGINS || 'http://127.0.0.1:4173,http://localhost:4173').split(',').map((origin) => origin.trim()).filter(Boolean), provider = '', quotaLimits = {} } = {}) {
  const resolvedProvider = resolveProvider(provider, { accessSecret, cliPath });
  const useCli = resolvedProvider === 'cli';
  const providerConfigured = resolvedProvider === 'http' ? Boolean(accessSecret) : resolvedProvider === 'cli' ? Boolean(cliPath) : false;
  const aiClusterEnabled = process.env.ZHIBIAN_AI_CLUSTER === '1';
  const caches = new Map();
  const quota = {
    search: intInRange(quotaLimits.search, 5000, 1_000_000),
    hot: intInRange(quotaLimits.hot, 100, 1_000_000),
    directAnswer: intInRange(quotaLimits.directAnswer, 100, 1_000_000),
  };
  // 缓存可观测性统计：O(1) 内存计数，不含 Secret / 响应体 / 用户数据。
  const stats = {
    cacheHits: 0,
    upstreamCalls: 0,
    errors: 0,
    refusals: 0, // 本地拒绝：Origin 403 / OAuth 501 / 无效请求 400
    quota: {
      search: { used: 0, limit: quota.search },
      hot: { used: 0, limit: quota.hot },
      directAnswer: { used: 0, limit: quota.directAnswer },
    },
  };
  const quotaExceeded = () => ({ status: 429, body: { reason: 'quota_exhausted' } });
  const consumeQuota = (endpoint) => {
    const bucket = stats.quota[endpoint];
    if (bucket.used >= bucket.limit) {
      stats.refusals += 1;
      return false;
    }
    bucket.used += 1;
    return true;
  };
  const endpointOf = (key) => (key.startsWith('search') ? 'search' : key.startsWith('hot') ? 'hot' : 'directAnswer');
  const inflight = new Map();
  const request = async (key, path, init = {}) => {
    if (!providerConfigured) return { status: 503, body: { reason: 'not_configured' } };
    const hit = caches.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) { stats.cacheHits += 1; return hit.value; }
    const existing = inflight.get(key);
    if (existing) return existing;
    const operation = (async () => {
      if (!consumeQuota(endpointOf(key))) return quotaExceeded();
      stats.upstreamCalls += 1;
      if (useCli) {
        const cliArgs = path.startsWith('/api/v1/content/zhihu_search')
          ? ['search', 'zhihu', '--query', new URLSearchParams(path.split('?')[1] || '').get('Query') || '', '--count', new URLSearchParams(path.split('?')[1] || '').get('Count') || '10']
          : path.startsWith('/api/v1/content/hot_list')
            ? ['hot', '--limit', new URLSearchParams(path.split('?')[1] || '').get('Limit') || '15']
            : null;
        if (cliArgs) {
          const result = await runZhihuCli(cliPath, cliArgs, { spawnImpl });
          if (!result.ok) { stats.errors += 1; return { status: result.status, body: { reason: result.error } }; }
          const value = { status: 200, body: result.body };
          if (result.body?.Code === 0) caches.set(key, { at: Date.now(), value });
          return value;
        }
        return { status: 503, body: { reason: 'not_configured' } };
      }
      try {
        const response = await fetchImpl(`${apiBase}${path}`, {
          ...init,
          signal: AbortSignal.timeout(upstreamTimeoutMs),
          headers: {
            Authorization: `Bearer ${accessSecret}`,
            'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
            'Content-Type': 'application/json',
            ...(init.headers || {}),
          },
        });
        const body = await response.json().catch(() => ({ Code: 90001, Message: 'Invalid upstream response' }));
        const value = { status: response.status, body };
        // 上游非 2xx 或业务错误码（非 0 且非直答 choices）计入错误
        if (!response.ok || (body.Code && body.Code !== 0 && !body.choices)) stats.errors += 1;
        if (response.ok && (body.Code === 0 || body.choices)) caches.set(key, { at: Date.now(), value });
        return value;
      } catch (e) {
        stats.errors += 1;
        // 保持已有适配层错误契约：网络/超时都由客户端统一降级为 network_error。
        return { status: 504, body: { reason: 'network_error' } };
      }
    })();
    inflight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inflight.get(key) === operation) inflight.delete(key);
    }
  };
  const proxy = async (method, pathname, searchParams, body, requestOrigin = '') => {
    if (pathname.startsWith('/api/zhihu/') && requestOrigin && !allowedOrigins.includes(requestOrigin)) {
      stats.refusals += 1;
      return { status: 403, body: { error: 'origin_not_allowed' } };
    }
    if (method === 'GET' && pathname === '/api/zhihu/search') {
      const query = String(searchParams.get('query') || '').trim();
      if (!query) { stats.refusals += 1; return { status: 400, body: { Code: 10001, Message: 'query is required' } }; }
      if (query.length > 500) { stats.refusals += 1; return { status: 400, body: { Code: 10002, Message: 'query is too long' } }; }
      const count = intInRange(searchParams.get('count'), 10, 10);
      return request(`search:${query}:${count}`, `/api/v1/content/zhihu_search?Query=${encodeURIComponent(query)}&Count=${count}`);
    }
    if (method === 'GET' && pathname === '/api/zhihu/hot') {
      const limit = intInRange(searchParams.get('limit'), 15, 30);
      return request(`hot:${limit}`, `/api/v1/content/hot_list?Limit=${limit}`);
    }
    if (method === 'POST' && pathname === '/api/zhihu/direct-answer') {
      const query = String(body?.query || '').trim();
      if (!query) { stats.refusals += 1; return { status: 400, body: { error: { code: 'invalid_request', message: 'query is required' } } }; }
      if (query.length > 500) { stats.refusals += 1; return { status: 400, body: { error: { code: 'invalid_request', message: 'query is too long' } } }; }
      if (!providerConfigured) return { status: 503, body: { reason: 'not_configured' } };
      const directKey = `direct:${query}`;
      const cachedDirect = caches.get(directKey);
      if (cachedDirect && Date.now() - cachedDirect.at < CACHE_TTL_MS && body?.stream !== true) {
        stats.cacheHits += 1;
        return cachedDirect.value;
      }
      // US-25 流式直答：stream=true 时透传上游 SSE，并做 thinking 脱敏（默认剥离，显式开关才放行）
      if (body?.stream === true) {
        if (useCli) {
          if (!consumeQuota('directAnswer')) return quotaExceeded();
          stats.upstreamCalls += 1;
          return { status: 200, stream: streamZhihuCli(cliPath, ['answer', '--query', query, '--model', DEFAULT_DIRECT_MODEL, '--stream', '--output', 'sse', '--timeout', CLI_ANSWER_TIMEOUT], { spawnImpl, onError: () => { stats.errors += 1; } }) };
        }
        return streamDirectAnswer({ fetchImpl, apiBase, accessSecret, query, showThinking: process.env.ZHIBIAN_SHOW_THINKING === '1', stats, key: directKey, timeoutMs: upstreamTimeoutMs, quotaCheck: () => consumeQuota('directAnswer') });
      }
      if (useCli) {
        if (!consumeQuota('directAnswer')) return quotaExceeded();
        stats.upstreamCalls += 1;
        const result = await runZhihuCli(cliPath, ['answer', '--query', query, '--model', DEFAULT_DIRECT_MODEL, '--output', 'json', '--timeout', CLI_ANSWER_TIMEOUT], { spawnImpl });
        if (!result.ok) { stats.errors += 1; return { status: result.status, body: { reason: result.error } }; }
        const value = { status: 200, body: result.body };
        if (result.body?.choices) caches.set(directKey, { at: Date.now(), value });
        return value;
      }
      return request(directKey, '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: DEFAULT_DIRECT_MODEL, messages: [{ role: 'user', content: query }], stream: false }) });
    }
    if (method === 'POST' && pathname === '/api/zhihu/classify') {
      if (!aiClusterEnabled) return { status: 503, body: { reason: 'ai_cluster_disabled' } };
      const items = Array.isArray(body?.items)
        ? body.items.filter((item) => item && item.id && item.excerpt).slice(0, 10).map((item) => ({ id: String(item.id), excerpt: String(item.excerpt).slice(0, 900) }))
        : [];
      if (!items.length) return { status: 400, body: { error: { code: 'invalid_request', message: 'items are required' } } };
      const digest = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
      const key = `directAnswer:cluster:${digest}`;
      let upstream;
      const cached = caches.get(key);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        stats.cacheHits += 1;
        upstream = cached.value;
      } else if (useCli) {
        // CLI 模式也必须走 CLI 的 answer 能力；不能因复用统一契约
        // 而把未配置凭证的 HTTP 请求漏出去。
        if (!consumeQuota('directAnswer')) return quotaExceeded();
        stats.upstreamCalls += 1;
        const result = await runZhihuCli(cliPath, [
          'answer', '--query', buildClusterPrompt(items),
          '--model', DEFAULT_DIRECT_MODEL, '--output', 'json', '--timeout', CLI_ANSWER_TIMEOUT,
        ], { spawnImpl });
        if (!result.ok) {
          stats.errors += 1;
          upstream = { status: result.status, body: { reason: result.error } };
        } else {
          upstream = { status: 200, body: result.body };
          if (result.body?.choices) caches.set(key, { at: Date.now(), value: upstream });
        }
      } else {
        upstream = await request(key, '/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({
            model: DEFAULT_DIRECT_MODEL,
            messages: [{ role: 'user', content: buildClusterPrompt(items) }],
            stream: false,
          }),
        });
      }
      const content = upstream.body?.choices?.[0]?.message?.content || '';
      const parsed = parseClusterResponse(content, items);
      if (upstream.status !== 200 || !parsed.ok) return { status: 502, body: { reason: parsed.reason === 'invalid_json' ? 'ai_cluster_invalid_response' : 'ai_cluster_incomplete' } };
      return { status: 200, body: { ok: true, items: parsed.items } };
    }
    // B1 预留入口：在实现 OAuth 回调、签名会话和每用户 token 隔离前，绝不读取用户数据。
    if (pathname.startsWith('/api/zhihu/me/')) {
      stats.refusals += 1;
      return { status: 501, body: { reason: 'oauth_session_required' } };
    }
    return null;
  };
  proxy.recordRefusal = () => { stats.refusals += 1; };
  // 暴露统计快照（复制对象，避免外部改写内部计数）
  proxy.stats = () => ({
    cacheHits: stats.cacheHits,
    upstreamCalls: stats.upstreamCalls,
    errors: stats.errors,
    refusals: stats.refusals,
    quota: {
      search: { ...stats.quota.search },
      hot: { ...stats.quota.hot },
      directAnswer: { ...stats.quota.directAnswer },
    },
  });
  return proxy;
}

// ---------- US-25 流式直答（SSE 透传 + thinking 脱敏） ----------
// 纯函数：把上游 SSE 文本行转成「只含正文增量」的 SSE 行；thinking 默认剥离。
// showThinking=false（默认）：choices[].delta.reasoning_content / message.reasoning_content 一律不转发
export function sanitizeSSELine(line, { showThinking = false } = {}) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith('data:')) return null; // 非 data 行（注释/心跳）过滤
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return 'data: [DONE]\n\n';
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return null; }
  const choice = parsed?.choices?.[0];
  if (!choice) return null; // 无 choices 的元数据帧过滤
  const delta = choice.delta || choice.message || {};
  if (showThinking) return line + '\n'; // 显式开关：原样透传（含 thinking）
  // 脱敏：只保留 content 增量；reasoning_content 等一律丢弃
  const content = delta.content;
  if (content === undefined || content === null) return null;
  const out = { choices: [{ index: choice.index ?? 0, delta: { content: String(content) } }] };
  if (parsed.id) out.id = parsed.id;
  return `data: ${JSON.stringify(out)}\n\n`;
}

// 调用上游直答流式接口，返回 { status, stream }（ReadableStream<Uint8Array>，含脱敏后的 SSE）
export async function streamDirectAnswer({ fetchImpl = fetch, apiBase = API_BASE, accessSecret, query, showThinking = false, stats, key = '', timeoutMs = 20_000, quotaCheck = null } = {}) {
  if (!accessSecret) return { status: 503, body: { reason: 'not_configured' } };
  if (quotaCheck) {
    if (!quotaCheck()) return { status: 429, body: { reason: 'quota_exhausted' } };
  } else {
    stats.quota.directAnswer.used += 1;
  }
  stats.upstreamCalls += 1;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(`${apiBase}/v1/chat/completions`, {
      method: 'POST',
      signal: timeoutSignal,
      headers: {
        Authorization: `Bearer ${accessSecret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_DIRECT_MODEL,
        messages: [{ role: 'user', content: query }],
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      stats.errors += 1;
      const errBody = await response.json().catch(() => ({ Code: 90001, Message: 'Upstream stream error' }));
      return { status: response.status, body: errBody };
    }
    // 把上游字节流逐行脱敏后转发（thinking 剥离）
    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream({
        start(controller) { controller._sseBuffer = ''; },
        transform(chunk, controller) {
          controller._sseBuffer += String(chunk);
          let index;
          while ((index = controller._sseBuffer.indexOf('\n')) >= 0) {
            const line = controller._sseBuffer.slice(0, index);
            controller._sseBuffer = controller._sseBuffer.slice(index + 1);
            const out = sanitizeSSELine(line, { showThinking });
            if (out) controller.enqueue(out);
          }
        },
        flush(controller) {
          const out = sanitizeSSELine(controller._sseBuffer, { showThinking });
          if (out) controller.enqueue(out);
        },
      }))
      .pipeThrough(new TextEncoderStream());
    return { status: 200, stream, streamKey: key };
  } catch (e) {
    stats.errors += 1;
    if (timeoutSignal.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError') return { status: 504, body: { reason: 'upstream_timeout' } };
    return { status: 502, body: { Code: 90002, Message: 'Upstream unreachable' } };
  }
}

// ---------- 环境变量启动门禁（缺失必需变量时启动即失败） ----------
// 生产模式缺关键 env 直接 FATAL 退出并列出缺失项，绝不静默降级。
// 纯函数便于测试；返回缺失项数组（空 = 通过）。
export function validateEnv({
  production = false,
  provider = 'mock',
  allowedOrigins = [],
  accessSecret = '',
  cliPath = '',
  oauthRequired = false,
  oauthAppId = '',
  oauthAppKey = '',
  oauthRedirectUri = '',
} = {}) {
  const missing = [];
  if (production && (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0)) missing.push('ZHIBIAN_ALLOWED_ORIGINS');
  if (provider === 'http' && !accessSecret) missing.push('ZHIHU_ACCESS_SECRET');
  if (provider === 'cli' && !cliPath) missing.push('ZHIHU_CLI_PATH');
  if (oauthRequired && !oauthAppId) missing.push('ZHIHU_OAUTH_APP_ID');
  if (oauthRequired && !oauthAppKey) missing.push('ZHIHU_OAUTH_APP_KEY');
  if (oauthRequired && !oauthRedirectUri) missing.push('ZHIHU_OAUTH_REDIRECT_URI');
  return missing;
}

// ---------- 内存滑动窗口限流（按客户端 IP 计数，超限快速拒绝） ----------
// 返回 check(ip) => { allowed, remaining }；定时清理过期窗口，unref 不阻塞进程退出。
export function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    }
  }, windowMs);
  timer.unref();
  return {
    check(ip) {
      const now = Date.now();
      const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) { hits.set(ip, arr); return { allowed: false, remaining: 0 }; }
      arr.push(now);
      hits.set(ip, arr);
      return { allowed: true, remaining: max - arr.length };
    },
    // 供测试观测窗口状态
    _count(ip) { return (hits.get(ip) || []).filter((t) => Date.now() - t < windowMs).length; },
  };
}

// ---------- CSRF 防护（Origin 同源校验子集） ----------
// 非 GET 请求必须携带 Origin 且 Origin 在允许白名单内；缺失 → 400，陌生 → 403。
export function csrfGuard(req, url, allowedOrigins) {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return null;
  if (!String(url.pathname).startsWith('/api/')) return null;
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return { status: 400, body: { error: { code: 'csrf_origin_required', message: 'Origin header required for state-changing requests' } } };
  if (!allowedOrigins.includes(origin)) return { status: 403, body: { error: { code: 'csrf_origin_not_allowed' } } };
  return null;
}

export function getClientIp(req, { trustProxy = false } = {}) {
  const remote = String(req?.socket?.remoteAddress || '').trim();
  if (!trustProxy) return remote || 'unknown';
  return String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || remote || 'unknown';
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) {
      const error = new Error('payload too large');
      error.statusCode = 413;
      throw error;
    }
  }
  return raw ? JSON.parse(raw) : {};
}

async function serveFile(pathname, res, provider, aiCluster = 'off') {
  const clean = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^[/\\]+/, '');
  if (!PUBLIC_FILE_NAMES.has(clean) && !PUBLIC_FILE_PREFIXES.some((prefix) => clean.startsWith(prefix))) throw new Error('not found');
  const file = join(ROOT, clean);
  if (!file.startsWith(ROOT)) throw new Error('forbidden');
  const info = await stat(file);
  if (!info.isFile()) throw new Error('not found');
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  let content = await readFile(file);
  if (clean === 'index.html') {
    // 注入运行时数据源与可选的 AI 分组开关。
    content = Buffer.from(content.toString().replace('data-provider="mock"', `data-provider="${provider}" data-ai-cluster="${aiCluster}"`));
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  res.end(content);
}

export function createAppServer(options = {}) {
  // Origin 白名单：与 proxy 共用同一份（CSRF 校验同源）
  const allowedOrigins = options.allowedOrigins || (process.env.ZHIBIAN_ALLOWED_ORIGINS || 'http://127.0.0.1:4173,http://localhost:4173').split(',').map((s) => s.trim()).filter(Boolean);
  const provider = resolveProvider(options.provider, { accessSecret: options.accessSecret ?? process.env.ZHIHU_ACCESS_SECRET ?? '', cliPath: options.cliPath ?? process.env.ZHIHU_CLI_PATH ?? '' });
  const proxy = createZhihuProxy({ ...options, provider, allowedOrigins });
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const accessSecret = options.accessSecret ?? process.env.ZHIHU_ACCESS_SECRET ?? '';
  const oauthRedirectUri = options.oauthRedirectUri ?? process.env.ZHIHU_OAUTH_REDIRECT_URI ?? '';
  const oauthCookieSecure = String(oauthRedirectUri).startsWith('https:');
  const oauth = createOAuthSessionStore({
    fetchImpl: options.fetchImpl || fetch,
    oauthBase: options.oauthBase || process.env.ZHIHU_OAUTH_BASE || OAUTH_BASE,
    appId: options.oauthAppId ?? process.env.ZHIHU_OAUTH_APP_ID ?? '',
    appKey: options.oauthAppKey ?? process.env.ZHIHU_OAUTH_APP_KEY ?? '',
    redirectUri: oauthRedirectUri,
  });
  const auditToken = String(options.auditToken ?? process.env.ZHIBIAN_AUDIT_TOKEN ?? '');
  const aiCluster = process.env.ZHIBIAN_AI_CLUSTER === '1' ? 'on' : 'off';
  // 通用限流：/api/zhihu/* 与 stats 默认 60/min/IP（防误操作/爬虫耗尽配额）
  const limiter = createRateLimiter({ windowMs: 60_000, max: options.rateLimitMax ?? 60 });
  const trustProxy = options.trustProxy === true || process.env.ZHIBIAN_TRUST_PROXY === '1';
  const clientIp = (req) => getClientIp(req, { trustProxy });
  // 审计日志（US-09）：内存环形缓冲；配置 ZHIBIAN_AUDIT_FILE 后追加落盘并在重启时恢复，仍不含正文/Secret
  const audit = createAuditLog({ capacity: options.auditCapacity ?? 200, file: options.auditFile || process.env.ZHIBIAN_AUDIT_FILE || null });
  const oauthCookieOptions = { path: '/api/zhihu', maxAge: 0, secure: oauthCookieSecure };
  const oauthFailure = (res) => {
    res.setHeader('Set-Cookie', oauthCookie(OAUTH_PREAUTH_COOKIE, '', { ...oauthCookieOptions, path: '/api/zhihu/oauth' }));
    res.writeHead(302, { Location: '/?oauth=failed', 'Cache-Control': 'no-store' });
    res.end();
  };
  const oauthUserRequest = async (pathname, searchParams, cookieHeader) => {
    if (!accessSecret || !oauth.configured()) return { status: 503, body: { reason: 'oauth_not_configured' } };
    const { session } = oauth.get(cookieHeader);
    if (!session) return { status: 401, body: { reason: 'oauth_session_required' } };
    const userHeaders = {
      Authorization: `Bearer ${accessSecret}`,
      'X-OAuth-Token': session.oauthToken,
      'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
      'Content-Type': 'application/json',
    };
    let upstreamPath;
    if (pathname === '/api/zhihu/me/favlists') {
      upstreamPath = '/api/v1/user/favlists?Limit=20';
    } else if (pathname === '/api/zhihu/me/favlist-contents') {
      const token = String(searchParams.get('FavlistUrlToken') || '');
      if (!/^\d+$/.test(token)) return { status: 400, body: { reason: 'invalid_request' } };
      if (!oauth.allowsFavlist(session, token)) return { status: 403, body: { reason: 'favlist_not_selected' } };
      upstreamPath = `/api/v1/user/favlist_contents?FavlistUrlToken=${encodeURIComponent(token)}&Limit=20`;
    } else {
      return null;
    }
    try {
      const upstream = await (options.fetchImpl || fetch)(`${options.apiBase || API_BASE}${upstreamPath}`, {
        signal: AbortSignal.timeout(options.upstreamTimeoutMs || 20_000),
        headers: userHeaders,
      });
      const body = await upstream.json().catch(() => ({ Code: 90001, Message: 'Invalid upstream response' }));
      if (upstream.status === 401 || upstream.status === 403) {
        oauth.logout(cookieHeader);
        return { status: 401, body: { reason: 'oauth_session_expired' } };
      }
      if (!upstream.ok || body?.Code !== 0) return { status: upstream.status || 502, body };
      if (pathname === '/api/zhihu/me/favlists') oauth.rememberFavlists(session, body?.Data?.Items);
      return { status: 200, body };
    } catch {
      return { status: 504, body: { reason: 'network_error' } };
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const reqId = String(req.headers['x-req-id'] || randomUUID());
    const started = Date.now();
    let requestBody = {};
    res.setHeader('X-Request-Id', reqId);
    // 请求日志（JSON 结构化，query 脱敏）；响应完成时补 status/耗时
    res.on('finish', () => {
      const meta = {
        reqId, method: req.method, path: url.pathname,
        query: sanitizePayload(Object.fromEntries(url.searchParams)),
        status: res.statusCode, ms: Date.now() - started, ip: clientIp(req),
      };
      const sensitiveOAuthRoute = url.pathname.startsWith('/api/zhihu/oauth/') || url.pathname.startsWith('/api/zhihu/me/');
      if (!sensitiveOAuthRoute) jsonLog('info', 'request', meta);
      // 审计（US-09）：仅 /api/zhihu/* 业务端点入审计，静态资源不审计（降噪）；
      // 只记录 query 参数名与脱敏值，POST body 只留字段名（toAuditEntry 内处理）
      if (url.pathname.startsWith('/api/zhihu/') && !sensitiveOAuthRoute) {
        audit.record({
          reqId, method: req.method, path: url.pathname,
          origin: req.headers.origin || '', ip: clientIp(req), status: res.statusCode,
          ms: Date.now() - started, query: Object.fromEntries(url.searchParams), body: requestBody,
        });
      }
    });
    try {
      // 限流：代理与 stats 均受 60/min/IP 保护（在 stats 分支之前，避免绕过）
      if (url.pathname.startsWith('/api/zhihu/')) {
        const rl = limiter.check(clientIp(req));
        if (!rl.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' });
          res.end(JSON.stringify({ error: { code: 'rate_limited', message: '请求过于频繁，请稍后再试。' } }));
          return;
        }
      }
      // 缓存可观测性端点：仅返回统计快照，不含 Secret / 响应体缓存 / 用户数据
      if (req.method === 'GET' && url.pathname === '/api/zhihu/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(proxy.stats()));
        return;
      }
      // 健康检查（US-23）：供 systemd/PM2/Caddy 探活；200 表示进程存活，不含业务敏感信息
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()), provider, ts: Date.now() }));
        return;
      }
      // 审计快照（US-09）：运维查看操作元信息（已脱敏，不含正文/Secret）；静态资源不开放
      if (req.method === 'GET' && url.pathname === '/api/zhihu/audit') {
        if (production && !auditToken) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        if (production && req.headers.authorization !== `Bearer ${auditToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' });
          res.end(JSON.stringify({ error: 'audit_auth_required' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(audit.snapshot()));
        return;
      }
      // CSRF：非 GET /api/* 必须带 Origin 且在白名单
      const csrf = csrfGuard(req, url, allowedOrigins);
      if (csrf) {
        proxy.recordRefusal();
        res.writeHead(csrf.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(csrf.body));
        return;
      }
      requestBody = req.method === 'POST' ? await readJson(req) : {};
      if (req.method === 'GET' && url.pathname === '/api/zhihu/oauth/login') {
        const authorization = oauth.begin();
        if (!authorization) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ reason: 'oauth_not_configured' }));
          return;
        }
        res.setHeader('Set-Cookie', oauthCookie(OAUTH_PREAUTH_COOKIE, authorization.preauthId, { maxAge: authorization.maxAge, path: '/api/zhihu/oauth', secure: oauthCookieSecure }));
        res.writeHead(302, { Location: authorization.authorizationUrl, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/zhihu/oauth/callback') {
        const authorizationCode = String(url.searchParams.get('authorization_code') || url.searchParams.get('code') || '');
        const completed = await oauth.complete({ cookieHeader: req.headers.cookie || '', authorizationCode });
        if (!completed) {
          oauthFailure(res);
          return;
        }
        res.setHeader('Set-Cookie', [
          oauthCookie(OAUTH_PREAUTH_COOKIE, '', { ...oauthCookieOptions, path: '/api/zhihu/oauth' }),
          oauthCookie(OAUTH_SESSION_COOKIE, completed.sessionId, { maxAge: completed.maxAge, path: '/api/zhihu', secure: oauthCookieSecure }),
        ]);
        res.writeHead(302, { Location: '/?oauth=connected', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/zhihu/oauth/logout') {
        oauth.logout(req.headers.cookie || '');
        res.setHeader('Set-Cookie', oauthCookie(OAUTH_SESSION_COOKIE, '', oauthCookieOptions));
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/zhihu/me/')) {
        const userData = await oauthUserRequest(url.pathname, url.searchParams, req.headers.cookie || '');
        if (userData) {
          res.writeHead(userData.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(userData.body));
          return;
        }
      }
      const proxied = await proxy(req.method || 'GET', url.pathname, url.searchParams, req.method === 'POST' ? requestBody : undefined, req.headers.origin || '');
      if (proxied) {
        // US-25 流式响应（SSE）：Content-Type text/event-stream，逐块转发（thinking 已在 proxy 层脱敏）
        if (proxied.stream) {
          const iterator = proxied.stream[Symbol.asyncIterator]();
          let first;
          try {
            first = await iterator.next();
          } catch (error) {
            const status = error.statusCode || 502;
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ reason: error.reason || 'stream_error' }));
            return;
          }
          if (first.done) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ reason: 'empty_stream' }));
            return;
          }
          res.writeHead(proxied.status, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          res.write(first.value);
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              res.write(next.value);
            }
            res.end();
          } catch (error) {
            // headers 已发送后无法切换 HTTP 状态；销毁截断流，让客户端将其识别为可重试网络失败。
            res.destroy(error);
          }
          return;
        }
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        if (proxied.status === 429) headers['Retry-After'] = '60';
        res.writeHead(proxied.status, headers);
        res.end(JSON.stringify(proxied.body));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      await serveFile(url.pathname, res, provider, aiCluster);
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : error.statusCode || 404;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 400 ? 'invalid_json' : 'not_found' }));
    }
  });
  server.flushPersistence = () => audit.flush();
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadDotEnvFile(join(ROOT, '.env'));
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  // provider 单一事实源：与 createZhihuProxy 共用 resolveProvider，避免出现
  // “代理已配真实凭据、页面却注入 mock”的分裂态（页面注入的 provider 决定浏览器数据源）。
  const provider = resolveProvider(process.env.ZHIBIAN_PROVIDER || '', {
    accessSecret: process.env.ZHIHU_ACCESS_SECRET || '',
    cliPath: process.env.ZHIHU_CLI_PATH || '',
  });
  const allowedOrigins = (process.env.ZHIBIAN_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const missing = validateEnv({
    production: process.env.NODE_ENV === 'production',
    provider,
    allowedOrigins,
    accessSecret: process.env.ZHIHU_ACCESS_SECRET || '',
    cliPath: process.env.ZHIHU_CLI_PATH || '',
    oauthRequired: process.env.ZHIHU_OAUTH_REQUIRED === '1',
    oauthAppId: process.env.ZHIHU_OAUTH_APP_ID || '',
    oauthAppKey: process.env.ZHIHU_OAUTH_APP_KEY || '',
    oauthRedirectUri: process.env.ZHIHU_OAUTH_REDIRECT_URI || '',
  });
  if (missing.length) {
    console.error(`FATAL: 缺失环境变量（启动门禁）: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (provider === 'mock' && process.env.NODE_ENV === 'production') {
    console.warn('WARN: 生产形态运行在 mock（演示数据）模式；如需真实知乎数据，请设置 ZHIBIAN_PROVIDER=http 并提供 ZHIHU_ACCESS_SECRET。');
  }
  const server = createAppServer({ provider });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.flushPersistence?.();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(port, host, () => console.log(`知辩预览： http://${host}:${port}（provider=${provider}）`));
}
