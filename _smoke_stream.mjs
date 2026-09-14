// _smoke_stream.mjs — US-25 直答流式 SSE + thinking 脱敏
// 运行：node _smoke_stream.mjs
import assert from 'node:assert/strict';
import { createZhihuProxy, sanitizeSSELine, streamDirectAnswer } from './server.mjs';

// ---- 脱敏纯函数 ----
{
  // 只有正文增量
  const out = sanitizeSSELine('data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}');
  assert.ok(out.includes('你好') && !out.includes('reasoning_content'), '正文增量保留');
  // thinking 剥离：content 与 reasoning_content 同帧 → 只留 content
  const mixed = sanitizeSSELine('data: {"choices":[{"index":0,"delta":{"content":"答","reasoning_content":"思考中"}}]}');
  assert.ok(mixed.includes('答') && !mixed.includes('思考中') && !mixed.includes('reasoning_content'), '同帧脱敏');
  // 纯 thinking 帧 → 丢弃
  assert.equal(sanitizeSSELine('data: {"choices":[{"index":0,"delta":{"reasoning_content":"思考"}}]}'), null, '纯 thinking 帧丢弃');
  // 非 data 行 → 丢弃
  assert.equal(sanitizeSSELine(': ping'), null);
  // [DONE] 保留
  assert.equal(sanitizeSSELine('data: [DONE]'), 'data: [DONE]\n\n');
  // 显式开关：thinking 原样透传
  const raw = sanitizeSSELine('data: {"choices":[{"index":0,"delta":{"content":"答","reasoning_content":"思考"}}]}', { showThinking: true });
  assert.ok(raw.includes('reasoning_content'), '开关打开时透传 thinking');
  // 坏 JSON → null
  assert.equal(sanitizeSSELine('data: not-json'), null);
}

// ---- 流式透传（mock 上游）----
{
  const fakeUpstream = async () => new Response([
    'data: {"choices":[{"delta":{"reasoning_content":"内部思考"}}]}',
    'data: {"choices":[{"delta":{"content":"关于攒钱"}}]}',
    'data: {"choices":[{"delta":{"content":"的结论"}}]}',
    'data: [DONE]',
    '',
  ].join('\n'), { status: 200 });
  const stats = { quota: { directAnswer: { used: 0 } }, upstreamCalls: 0, errors: 0 };
  const out = await streamDirectAnswer({ fetchImpl: fakeUpstream, accessSecret: 'fixture-value', query: 'q', stats });
  assert.equal(out.status, 200);
  assert.ok(out.stream, '返回流');
  const chunks = [];
  for await (const chunk of out.stream) chunks.push(Buffer.from(chunk).toString());
  const sse = chunks.join('');
  assert.ok(sse.includes('关于攒钱') && sse.includes('的结论'), '正文流式到达');
  assert.ok(!sse.includes('内部思考') && !sse.includes('reasoning_content'), 'thinking 已脱敏');
  assert.ok(sse.includes('[DONE]'), '结束标记保留');
  assert.equal(stats.quota.directAnswer.used, 1);

  // 上游把一条 SSE 行拆成多个网络块时，代理仍需拼回完整 JSON。
  const fragmentedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"拆'));
      controller.enqueue(new TextEncoder().encode('分行"}}]}\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
      controller.close();
    },
  });
  const fragmented = await streamDirectAnswer({ fetchImpl: async () => new Response(fragmentedBody, { status: 200 }), accessSecret: 'fixture-value', query: 'q', stats });
  const fragmentedChunks = [];
  for await (const chunk of fragmented.stream) fragmentedChunks.push(Buffer.from(chunk).toString());
  assert.ok(fragmentedChunks.join('').includes('拆分行'), '分块 SSE 行被正确拼接');

  // 无 Secret → 503
  const noSecret = await streamDirectAnswer({ accessSecret: '', query: 'q', stats });
  assert.equal(noSecret.status, 503);
}

// ---- createZhihuProxy 的 stream 分支（经 proxy 函数）----
{
  const upstream = async () => new Response(
    'data: {"choices":[{"delta":{"content":"流式正文"}}]}\ndata: [DONE]\n',
    { status: 200 },
  );
  const proxy = createZhihuProxy({ fetchImpl: upstream, accessSecret: 's' });
  const proxied = await proxy('POST', '/api/zhihu/direct-answer', new URLSearchParams(), { query: 'q', stream: true }, 'http://127.0.0.1:4173');
  assert.equal(proxied.status, 200);
  assert.ok(proxied.stream, 'proxy 返回流');
  const buf = [];
  for await (const c of proxied.stream) buf.push(Buffer.from(c).toString());
  assert.ok(buf.join('').includes('流式正文'));
}

console.log('PASS: _smoke_stream.mjs（SSE 脱敏 + 流式透传）');
