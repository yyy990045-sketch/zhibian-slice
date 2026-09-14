// 安全回归矩阵（钉死负向行为）
// 覆盖：①无来源必拒 ②来源必可点（URL 清洗）③配额短路 ④演示不冒充真实 ⑤Origin 403 ⑥me/* 501 ⑦统一错误出口完整性
import { createZhihuProxy } from './server.mjs';
import { generateChallenges } from './src/challenge.js';
import { sanitizeSourceUrl, isUsableSource } from './src/source.js';
import { ERROR_CODES, PUBLIC_MESSAGES, publicMessage } from './src/errors.js';
import { createAdapter } from './src/adapter.js';
import { MOCK_TOPICS } from './src/mockData.js';

let failures = 0;
const ok = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`);
  if (!condition) failures += 1;
};

// ---------- ① 统一错误出口完整性：每个错误码都有公共文案 ----------
const missingMsg = Object.values(ERROR_CODES).filter((c) => !PUBLIC_MESSAGES[c]);
ok(missingMsg.length === 0, `每个错误码都有公共文案（缺失：${missingMsg.join(',') || '无'}）`);
ok(publicMessage('not_configured').includes('离线示例数据'), 'not_configured 文案诚实标注离线示例');
ok(publicMessage('unknown_code') === '暂时无法获取数据。', '未知错误码兜底通用语');
ok(publicMessage('quota_exhausted', '直答额度已用完') === '直答额度已用完', '场景 fallback 优先于公共文案');

// ---------- ② 来源 URL 清洗：只留可公开知乎原文，绝不渲染死链 ----------
ok(sanitizeSourceUrl('') === '' && sanitizeSourceUrl(null) === '', '空/null URL 清洗为空');
ok(sanitizeSourceUrl('http://127.0.0.1:4173/secret') === '', '内网 URL 被清洗');
ok(sanitizeSourceUrl('https://evil.com/question/1') === '', '非知乎域 URL 被清洗');
ok(sanitizeSourceUrl('javascript:alert(1)') === '', 'javascript 协议被清洗');
ok(sanitizeSourceUrl('https://www.zhihu.com/question/123456/answer/789') === 'https://www.zhihu.com/question/123456', '知乎问答 URL 规范化为 /question/<id>');
ok(sanitizeSourceUrl('https://zhihu.com/question/1') === 'https://www.zhihu.com/question/1', 'zhihu.com 主域也放行并规范');
ok(sanitizeSourceUrl('https://www.zhihu.com/question/abc') === '', '伪造 question 路径（非数字）被清洗');
ok(sanitizeSourceUrl('not-a-url') === '', '非 URL 字符串被清洗');

// 引用质量门禁
ok(isUsableSource({ author: '甲', url: 'https://www.zhihu.com/question/9' }) === true, '正常来源可用');
ok(isUsableSource({ author: '', url: 'https://www.zhihu.com/question/9' }) === false, '无作者来源不可用');
ok(isUsableSource({ author: '甲', url: '' }) === false, '无 URL 来源不可用');

// ---------- ③ source-gated：无来源必拒（全部条目无可用来源 → 不产出挑战） ----------
const noSourceClusters = {
  support: { items: [{ id: 'a1', author: '', url: '', excerpt: '应该支持', authorityLevel: 1, voteupCount: 1 }] },
  oppose: { items: [{ id: 'a2', author: '乙', url: '', excerpt: '不该', authorityLevel: 1, voteupCount: 1 }] },
  conditional: { items: [] },
  insufficient: { items: [] },
};
const chNoSource = generateChallenges({ userStance: '支持', clusters: noSourceClusters, summary: { total: 1 } });
ok(chNoSource.length === 0, '全部来源不可用时挑战不产出（source-gated 必拒）');

// ---------- ④ sourceRef 只引用清洗后 URL（可用来源优先，内网来源被跳过） ----------
const safeClusters = {
  support: { items: [{ id: 'b1', author: '甲', url: 'https://www.zhihu.com/question/42', excerpt: '确实应该', authorityLevel: 4, voteupCount: 500 }] },
  oppose: {
    items: [
      { id: 'b2', author: '乙', url: 'http://127.0.0.1/internal', excerpt: '有风险', authorityLevel: 2, voteupCount: 10 },
      { id: 'b3', author: '丙', url: 'https://www.zhihu.com/question/7/answer/1', excerpt: '反方高赞', authorityLevel: 5, voteupCount: 900 },
    ],
  },
  conditional: { items: [] },
  insufficient: { items: [] },
};
const chSafe = generateChallenges({ userStance: '支持', clusters: safeClusters, summary: { total: 2 } });
ok(chSafe.length >= 1, '存在可用来源时产出盲区挑战');
ok(chSafe.some((c) => c.sourceRef && c.sourceRef.id === 'b3'), '盲区挑战引用可用反对来源 b3（内网 b2 被跳过）');
ok(chSafe.every((c) => !c.sourceRef || sanitizeSourceUrl(c.sourceRef.url) === c.sourceRef.url), 'sourceRef.url 均为清洗后 URL（无内网/未清洗泄漏）');
ok(chSafe.every((c) => !c.sourceRef || !c.sourceRef.url.includes('127.0.0.1')), '挑战引用不含内网 URL');

// ---------- ⑤ 配额短路：exhausted 后返回 quota_exhausted，不继续消耗 ----------
const mock = createAdapter({ mode: 'mock', topics: MOCK_TOPICS });
mock.quota.exhausted = true;
const qr = await mock.search('任意话题');
ok(qr.reason === 'quota_exhausted' && qr.empty === true, '配额耗尽后短路为 quota_exhausted');
const httpProv = createAdapter({ mode: 'http' });
httpProv.quota.exhausted = true;
const qr2 = await httpProv.search('x');
ok(qr2.reason === 'quota_exhausted', 'HttpProvider 配额耗尽同样短路');

// ---------- ⑥ 演示数据不冒充真实（mock 话题全部带 demo 标记） ----------
ok(MOCK_TOPICS.every((t) => t.demo === true), '全部演示话题带 demo 标记（全界面标注演示数据）');
const demoRes = await createAdapter({ mode: 'mock', topics: MOCK_TOPICS }).search(MOCK_TOPICS[0].query);
ok(demoRes.demo === true, 'mock 检索结果 demo 标记透传');

// ---------- ⑦ 服务端边界：Origin 403 + 通用代理拒绝 me/* ----------
const proxy = createZhihuProxy({
  accessSecret: 'fixture-access-value',
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Code: 0, Data: { Items: [] } }) }),
});
const badOrigin = await proxy('GET', '/api/zhihu/search', new URLSearchParams({ query: 'x' }), undefined, 'https://evil.example');
ok(badOrigin.status === 403 && badOrigin.body.error === 'origin_not_allowed', '陌生 Origin 请求代理返回 403');
const me = await proxy('GET', '/api/zhihu/me/favlists', new URLSearchParams());
ok(me.status === 501 && me.body.reason === 'oauth_session_required', '通用代理固定拒绝用户数据；必须经过 OAuth 会话层');

console.log(failures ? `\nFAIL=${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
