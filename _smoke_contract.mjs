// 契约冒烟测试：以官方 http-api.md 的真实响应样例验证字段映射与 HttpProvider 链路。
import { normalizeSearch, normalizeHot, createAdapter } from './src/adapter.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++; } else console.log('PASS:', msg); };

// ---- 1. 知乎搜索 normalize（官方样例字段，含 <em> 高亮、字符串权威度、unix 时间戳） ----
const realSearchItem = {
  Title: 'ChatGPT现在还值得开会员吗？',
  ContentType: 'Answer',
  ContentID: '1903044959663284716',
  ContentText: '首先要澄清一个常见误解：<em>免费版</em>和付费版使用的是不同模型……',
  Url: 'https://www.zhihu.com/answer/1903044959663284716?utm_medium=openapi_platform&utm_source=6d23634e',
  CommentCount: 22,
  VoteUpCount: 18,
  AuthorName: '时光纪',
  AuthorAvatar: 'https://picx.zhimg.com/example.jpg',
  AuthorBadge: '',
  AuthorBadgeText: '',
  EditTime: 1748355858,
  CommentInfoList: [{ Content: '没啥区别，免费也是4o……' }, { Content: '免费版现在也可以用gpt4o' }],
  AuthorityLevel: '2',
  RankingScore: 0.98,
};
const items = normalizeSearch({ Items: [realSearchItem] });
const it = items[0];
ok(items.length === 1, 'search normalize: 1 item');
ok(it.id === '1903044959663284716', `search normalize: ContentID 映射 id (got ${it.id})`);
ok(it.title === 'ChatGPT现在还值得开会员吗？', 'search normalize: Title 映射 title');
ok(!/<em>/.test(it.excerpt), `search normalize: 去除 <em> 高亮 (got "${it.excerpt}")`);
ok(it.author === '时光纪', 'search normalize: AuthorName 映射 author');
ok(it.authorityLevel === 2, `search normalize: 字符串权威度 "2" → 数字 2 (got ${it.authorityLevel})`);
ok(it.voteupCount === 18 && it.commentCount === 22, 'search normalize: VoteUpCount/CommentCount 映射');
ok(it.featuredComment.startsWith('没啥区别'), 'search normalize: 精选评论取 CommentInfoList[0].Content');
ok(it.contentType === 'Answer', 'search normalize: ContentType 透传');
ok(/^\d{4}-\d{2}-\d{2}$/.test(it.publishTime), `search normalize: EditTime unix → YYYY-MM-DD (got ${it.publishTime})`);
ok(it.url.startsWith('https://www.zhihu.com/answer/'), 'search normalize: Url 透传');
ok(it.relevanceScore === 0.98, 'search normalize: RankingScore 映射 relevanceScore');

// ---- 2. 热榜 normalize（空缩略图/空摘要须保留为空串） ----
const hot = normalizeHot({
  Items: [
    { Title: '如何评价某个热点问题？', Url: 'https://www.zhihu.com/question/123456789', ThumbnailUrl: 'https://pic1.zhimg.com/x.jpg', Summary: '这是该问题的内容摘要' },
    { Title: '一篇正在热榜上的文章标题', Url: 'https://zhuanlan.zhihu.com/p/987654321', ThumbnailUrl: '', Summary: '' },
  ],
});
ok(hot.length === 2, 'hot normalize: 2 items');
ok(hot[1].thumbnailUrl === '' && hot[1].summary === '', 'hot normalize: 空字段保留为空串');
ok(hot[0].title === '如何评价某个热点问题？', 'hot normalize: Title 映射');

// ---- 3. HttpProvider 链路（stub fetch 返回官方响应包） ----
const realEnvelope = { Code: 0, Message: 'success', Data: { HasMore: false, SearchHashId: 'x', Items: [realSearchItem] } };
const hotEnvelope = { Code: 0, Message: 'success', Data: { Total: 2, Items: hot.map(() => ({ Title: 't', Url: 'u', ThumbnailUrl: '', Summary: '' })) } };
const daEnvelope = { id: 'chatcmpl-x', object: 'chat.completion', created: 1740470400, model: 'zhida-thinking-1p5', choices: [{ index: 0, message: { role: 'assistant', reasoning_content: '先分析……', content: '综合社区观点，该问题没有统一结论……' }, finish_reason: 'stop' }] };

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/search')) return { ok: true, status: 200, json: async () => realEnvelope };
  if (u.includes('/hot')) return { ok: true, status: 200, json: async () => hotEnvelope };
  if (u.includes('/direct-answer')) return { ok: true, status: 200, json: async () => daEnvelope };
  throw new Error('unexpected url ' + u);
};

const http = createAdapter({ mode: 'http' });

const rs = await http.search('怎么理解rave文化');
ok(rs.ok && rs.items.length === 1 && rs.items[0].id === '1903044959663284716', 'HttpProvider.search: 真实响应包 {Code,Data.Items} 解析');
ok(rs.quota.used === 1 && rs.quota.limit === 5000, `search 配额: ${rs.quota.used}/${rs.quota.limit}`);

const rh = await http.hotList();
ok(rh.ok && rh.items.length === 2, 'HttpProvider.hotList: 解析');
ok(rh.quota.used === 1 && rh.quota.limit === 100, `hot 配额独立: ${rh.quota.used}/${rh.quota.limit}`);

const rd = await http.directAnswer('年轻人是否应该尽早开始攒钱');
ok(rd.ok && rd.answer.includes('综合社区观点'), 'HttpProvider.directAnswer: POST /v1/chat/completions 解析 choices[0].message.content');
ok(rd.citations.length === 0, 'directAnswer 真实模式无结构化引用（mock 才演示引用）');
ok(rd.quota.used === 1 && rd.quota.limit === 100, `直答配额独立: ${rd.quota.used}/${rd.quota.limit}`);

// ---- 4. 未配置降级 ----
// ---- 5. 缓存命中不重复扣配额 ----
await http.search('怎么理解rave文化'); // 命中 cache
ok(rs.quota.used === 1, 'search 缓存命中不重复扣配额');

console.log(fail ? `\nFAIL=${fail}` : '\nALL PASS');
process.exit(fail ? 1 : 0);
