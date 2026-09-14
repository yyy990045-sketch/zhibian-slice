// fields.js — 真实数据字段归一（US-12 field-mapper）
// 目的：真实知乎开放平台 API 返回 PascalCase 字段（ContentID/Title/ContentText/AuthorName/…），
//       而应用管线消费 camelCase 字段（id/title/excerpt/author/…）。
//       本模块是「单一事实源」的字段别名表：任何来源（搜索/热榜/收藏/直答引用）的原始记录
//       经 normalizeRecordFields 归一为统一应用 schema，管线其余部分不再感知来源差异。
//
// 诚实边界：只做字段名归一与数字解析，绝不编造正文/作者；无正文的条目显式标记 excerpt:''，
//       由 source.isUsableSource 与聚类逻辑决定是否可用，不在本层偷偷丢弃或伪造。

// 真实 API PascalCase → 应用 camelCase 的字段映射（唯一事实源，新增来源只改这里）
const FIELD_MAP = {
  // 搜索/热榜/收藏条目
  ContentID: 'id',
  Url: 'url',
  Title: 'title',
  ContentText: 'excerpt',
  Excerpt: 'excerpt',
  AuthorName: 'author',
  AuthorId: 'authorId',
  VoteUpCount: 'voteupCount',
  VoteupCount: 'voteupCount',
  CommentCount: 'commentCount',
  EditTime: 'publishTime',
  PublishTime: 'publishTime',
  AuthorityLevel: 'authorityLevel',
  ContentType: 'contentType',
  // 直答引用
  CiteTitle: 'title',
  CiteAuthor: 'author',
  CiteUrl: 'url',
};

// 全局别名表：跨来源通用的替代字段名（R2 GLOBAL_ALIASES 思路），优先级低于 FIELD_MAP
const GLOBAL_ALIASES = {
  id: ['Id', 'ID', 'contentId', 'cid'],
  title: ['QuestionTitle', 'Headline', 'Summary'],
  excerpt: ['Text', 'Body', 'Content', 'answerContent'],
  author: ['CreatorName', 'UserName', 'Author'],
  url: ['Link', 'ShareUrl', 'href'],
  voteupCount: ['VoteCount', 'AgreeCount', 'LikeCount'],
  commentCount: ['CommentNum', 'ReplyCount'],
  publishTime: ['CreatedAt', 'Timestamp', 'UpdatedAt'],
  authorityLevel: ['Level', 'Authority'],
};

// 数字解析：容忍「1.2万」「3,456」「45%」等展示形态；解析失败返回 fallback，不抛错
export function toNum(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value !== 'string') return fallback;
  let s = value.trim().replace(/,/g, '').replace(/[%％]/g, '');
  if (s.includes('万')) {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? Math.round(n * 10000) : fallback;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

// 归一化单条记录：PascalCase → camelCase，别名兜底，数字字段 toNum
export function normalizeRecordFields(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const out = {};
  const src = {};
  // 先按 FIELD_MAP 直接映射
  for (const [k, v] of Object.entries(rec)) {
    if (FIELD_MAP[k]) src[FIELD_MAP[k]] = v;
    else src[k] = v; // 已 camelCase 或未知字段原样保留
  }
  // 别名兜底：目标字段缺失时，从 GLOBAL_ALIASES 对应键位取值
  for (const [target, aliasKeys] of Object.entries(GLOBAL_ALIASES)) {
    if (src[target] === undefined || src[target] === null || src[target] === '') {
      for (const ak of aliasKeys) {
        if (rec[ak] !== undefined && rec[ak] !== null && rec[ak] !== '') { src[target] = rec[ak]; break; }
      }
    }
  }
  // 数字字段统一解析
  for (const numKey of ['voteupCount', 'commentCount', 'authorityLevel']) {
    src[numKey] = toNum(src[numKey]);
  }
  // 字符串字段统一类型；正文/标题超长截断（管线其他层不感知来源差异）
  for (const strKey of ['id', 'title', 'excerpt', 'author', 'url', 'publishTime', 'authorId']) {
    src[strKey] = src[strKey] === undefined || src[strKey] === null ? '' : String(src[strKey]);
    if ((strKey === 'title' || strKey === 'excerpt') && src[strKey].length > 500) {
      src[strKey] = src[strKey].slice(0, 500);
    }
  }
  return src;
}

// 归一化整批记录（真实采样/热榜入口，见 _smoke_fields.mjs）
export function normalizeRecords(items) {
  if (!Array.isArray(items)) return [];
  return items.map(normalizeRecordFields).filter((r) => r && (r.id || r.title || r.excerpt || r.url));
}
