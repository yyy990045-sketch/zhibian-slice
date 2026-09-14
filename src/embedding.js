// embedding.js — 本地 embedding 兜底（US-14）
// 目的：离线可用的语义相似度兜底（LLM 不可用/真实数据量大时不依赖外部服务）：
//   - 字符级 trigram/bigram 哈希 → 定长稀疏向量（256 维，按 unicode code point 哈希分桶）
//   - cosineSimilarity：两向量余弦相似度，NaN/零向量防御
//   - normalizeDimensions：向量 L2 归一（零向量返回全 0，不抛错）
// 诚实边界：字符 n-gram 只是「近似语义」——同形词/同义词召回弱于真 embedding，
//   仅作为去重/聚类辅助与离线基线，绝不伪装成语义理解（见 ADR-0001 决策记录）。

const DIM = 256;

// 字符串 → n-gram 序列（unicode code point 级别；长度不足 n 时按实际长度生成）
function ngrams(text, n) {
  const s = String(text || '').trim();
  const out = [];
  if (!s) return out;
  for (let i = 0; i <= s.length - n; i++) out.push(s.slice(i, i + n));
  return out.length ? out : [s]; // 短串兜底：整串作 1-gram
}

// 字符串 → 256 维稀疏向量（哈希分桶；多次出现叠加权重）
export function embed(text, { dim = DIM } = {}) {
  const vec = new Float64Array(dim);
  const grams = [...ngrams(text, 3), ...ngrams(text, 2)];
  for (const g of grams) {
    let h = 0;
    for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
    vec[h % dim] += 1;
  }
  return vec;
}

// L2 归一；零向量 → 全 0（不抛错，供 cosine 安全使用）
export function normalizeDimensions(vec, { dim = DIM } = {}) {
  const out = new Float64Array(dim);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (!norm) return out;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

// 余弦相似度：任一向量非零则计算，否则 0；NaN 防御（脏向量按 0 处理）
export function cosineSimilarity(a, b) {
  const len = Math.max(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

// 语义相似度快捷函数：两字符串的归一化余弦
export function textSimilarity(a, b) {
  return cosineSimilarity(normalizeDimensions(embed(a)), normalizeDimensions(embed(b)));
}

// 批量计算某文本与一组文本的相似度，返回降序 { index, score }（供去重/聚类辅助）
export function similarTo(text, candidates) {
  const target = normalizeDimensions(embed(text));
  return candidates
    .map((c, index) => ({ index, score: cosineSimilarity(target, normalizeDimensions(embed(c))) }))
    .sort((x, y) => y.score - x.score);
}
