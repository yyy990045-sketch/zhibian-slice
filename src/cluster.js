// cluster.js
// 四簇立场分类（确定性规则，不依赖 LLM）—— 主链路的确定性主干，对冲 LLM 接地风险。
// 输出每项的：cluster(支持/反对/条件成立/证据不足)、三维观点字段、stanceScore(-1..1 连续)、confidence、
//            heatScore(点赞热度)、evidenceCompleteness(证据/材料完整度)、conditionalSide(条件修饰侧)。

// 条件标记分强弱，单一事实源：LEXICON.conditional 由它派生，避免两处不同步。
// 强标记（如果 / 取决于 / 关键看…）单独出现即可判定为条件句；
// 弱标记（条件 / 场景 / 平衡 / 但）常被口语误带，如「工作与生活平衡」并非条件句。
const COND_MARKERS = {
  strong: ['如果', '要是', '取决于', '关键看', '看情况', '视情况', '因人而异', '分场景', '前提', '得看', '分人', '先看', '的话', '看你怎么', '区别在于', '对症下药'],
  weak: ['条件', '场景', '平衡', '但'],
};

const LEXICON = {
  // 议论文式显性立场词 + 叙事/体验式评价词（后者对知乎口语语料更关键）
  support: ['应该', '支持', '赞同', '同意', '拥护', '必要', '值得', '利大于弊', '越早越好', '强烈建议', '肯定', '必须', '主动', '建议', '跳板', '性价比',
    '踏实', '最对', '真香', '回不去', '千金不换', '变好', '划算'],
  oppose: ['不该', '反对', '风险', '隐患', '弊大于利', '警惕', '没必要', '拒绝', '危险', '夸大', '消失', '被动', '神话',
    '雷声大雨点小', '悔青', '想吐', '亏了', '焦虑', '带偏', '坑', '不如'],
  conditional: [...COND_MARKERS.strong, ...COND_MARKERS.weak],
  insufficient: ['缺乏数据', '暂无定论', '样本太小', '需要更多', '不确定', '没有定论', '难以判断', '没有足够', '很难', '慢一点', '没想清楚'],
};
const CLUSTER_ORDER = ['support', 'oppose', 'conditional', 'insufficient'];
export const CLUSTER_META = {
  support: { label: '支持', color: '#4A90B8' },        // 海蓝：支持渔区
  oppose: { label: '反对', color: '#FF6B35' },           // 争议橙：反对渔区
  conditional: { label: '条件成立', color: '#06A672' }, // 已读绿：带前提
  insufficient: { label: '证据不足', color: '#9AA4AE' }, // 雾灰：待证
};

const NEGATION = /(?:不|没|无|未|别|并非|并不)\s*$/;

function countHits(text) {
  const hits = { support: 0, oppose: 0, conditional: 0, insufficient: 0 };
  for (const cat of CLUSTER_ORDER) {
    for (const kw of LEXICON[cat]) {
      let from = 0;
      while (true) {
        const at = text.indexOf(kw, from);
        if (at < 0) break;
        const prefix = text.slice(Math.max(0, at - 4), at);
        if (cat === 'support' && NEGATION.test(prefix)) hits.oppose += 1;
        else if (!(cat === 'oppose' && NEGATION.test(prefix))) hits[cat] += 1;
        from = at + kw.length;
      }
    }
  }
  return hits;
}

// 「条件成立」不是独立立场，而是立场的修饰：
// 只有当条件信号足够强、且未被决定性立场压倒时，才把该条判为 conditional，
// 其方向（带前提的支持 / 带前提的反对）仍由净立场决定。
//
// 条件判定不能用「出现次数」一刀切：早期版本要求「至少 2 次命中」，把「如果…」
// 「关键看…」这类单标记条件句全部误杀成证据不足，回归集命中率由 2/30 掉到 0/30。
// 改为按标记强度计分（见 COND_MARKERS）。
const COND_STRONG = COND_MARKERS.strong;
const COND_WEAK = COND_MARKERS.weak;
const COND_MIN_SCORE = 1;       // 至少等效于 1 个强标记（或 2 个弱标记）
const COND_DOMINANCE = 0.5;     // 条件信号需达到主导立场词数量的 50%
const SIDE_EPSILON = 0.05;      // 净立场绝对值低于此值视为方向不明

export const STANCE_VALUES = ['support', 'oppose', 'neutral', 'mixed', 'uncertain'];
export const CONDITIONALITY_VALUES = ['unconditional', 'conditional', 'unclear'];
export const EVIDENCE_TYPE_VALUES = ['data', 'professional_citation', 'personal_experience', 'lacking_evidence', 'unclear'];

function detectEvidenceType(text) {
  const t = String(text || '');
  if (/(没有证据|缺乏证据|缺乏数据|暂无定论|样本太小|难以判断|没有足够|需要更多|不确定)/.test(t)) return 'lacking_evidence';
  if (/(研究|调查|报告|论文|文献|官方|央行|行业|统计|引用|根据|来源)/.test(t)) return /[0-9]/.test(t) ? 'data' : 'professional_citation';
  if (/(我|本人|亲身|亲历|经历|体验|用过|做了|我们团队|我的团队)/.test(t)) return 'personal_experience';
  if (/[0-9]/.test(t)) return 'data';
  return 'unclear';
}

function extractCondition(text, conditionality) {
  if (conditionality !== 'conditional') return '';
  const t = String(text || '');
  const marker = [...COND_STRONG, ...COND_WEAK].sort((a, b) => b.length - a.length).find((kw) => t.includes(kw));
  if (!marker) return '存在条件或场景限制，但规则无法抽取具体前提';
  const start = t.indexOf(marker);
  const tail = t.slice(start).split(/[。！？；;\n]/)[0].trim();
  return tail.slice(0, 120);
}

function sourceRefFromItem(item) {
  return {
    id: item?.id || '',
    author: item?.author || '',
    url: item?.url || '',
    publishTime: item?.publishTime || '',
  };
}

// 条件分支引导词：出现一次即开启一个新分支。
// 「取决于 / 关键看 / 分场景」只是条件语气，不开启分支，故不计入。
const BRANCH_MARKERS = ['如果', '要是', '的话'];
// 对比标记：分句之间结论相反的形态特征
const CONTRAST_ALWAYS = ['；', ';', '反之', '另一方面'];
// 单字转折词歧义大（视情况而定 / 反而 / 总而言之 里的「而」都不是转折），
// 故要求它位于分句开头才计入。
const CONTRAST_CLAUSE_INITIAL = ['但', '却', '而'];
const CLAUSE_BOUNDARY = /[，,；;。！？、\s]/;
// 对比标记后若紧跟条件词，说明它引出的是「前提」而非对立结论：
// 「越早越好，但前提是你收入稳定」是带前提的支持，不是双向条件。
const COND_AFTER_CONTRAST = ['前提', '条件', '如果', '的话', '要是', '除非'];

// 收集所有对比标记之后的位置，供「是否紧跟条件词」判断
function contrastTails(text) {
  const tails = [];
  for (const m of CONTRAST_ALWAYS) {
    let at = text.indexOf(m);
    while (at >= 0) {
      tails.push(at + m.length);
      at = text.indexOf(m, at + m.length);
    }
  }
  for (const m of CONTRAST_CLAUSE_INITIAL) {
    let at = text.indexOf(m);
    while (at >= 0) {
      const before = at === 0 ? '' : text[at - 1];
      if (at === 0 || CLAUSE_BOUNDARY.test(before)) tails.push(at + m.length);
      at = text.indexOf(m, at + m.length);
    }
  }
  return tails;
}

// 是否存在与前文对立的主张（而非给前文补一个前提）
function hasOpposingClaim(text) {
  return contrastTails(text).some(
    // 取决于/关键看等多字符条件词可能紧跟在转折词之后，窗口不能只取 4 个字符。
    (at) => !COND_AFTER_CONTRAST.some((c) => text.slice(at, at + 12).includes(c)),
  );
}

function countOccurrences(text, kw) {
  let n = 0;
  let at = text.indexOf(kw);
  while (at >= 0) {
    n += 1;
    at = text.indexOf(kw, at + kw.length);
  }
  return n;
}

function conditionalStrength(text) {
  let s = 0;
  for (const kw of COND_STRONG) s += countOccurrences(text, kw);
  for (const kw of COND_WEAK) s += countOccurrences(text, kw) * 0.5;
  return s;
}

export function classifyText(text) {
  const t = text == null ? '' : String(text);
  const hits = countHits(t);
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return {
      cluster: 'insufficient', stance: 'uncertain', conditionality: 'unclear', evidenceType: 'unclear', condition: '',
      stanceScore: 0, confidence: 0, support: 0, oppose: 0, isBidirectional: false,
      classificationMethod: 'rules', needsHumanReview: true,
    };
  }
  const support = hits.support;
  const oppose = hits.oppose;
  const cond = hits.conditional;
  const insufficient = hits.insufficient;
  const condStrength = conditionalStrength(t);

  // 双向条件（mixed）判据：结论随条件变化，或两分支结论相反。
  // 归为 mixed 而不是硬给一个方向，是因为全局词频计数无法把立场信号归属到具体分支——
  // 例如「如果指纯执行，风险很大；如果指解决问题的工程师，价值在上升」里的「风险」
  // 属于第一个分支，语义上支持被替代，但全局计数会把它算成反对。
  // 方向错误比方向不明更具误导性，因此宁可标 bidirectional 也不猜边。
  // 判据二要求正反信号同时出现，是为了不误伤「越早越好，但前提是你收入稳定」——
  // 那是带前提的支持，不是双向条件。
  const branchCount = BRANCH_MARKERS.reduce((n, kw) => n + countOccurrences(t, kw), 0);
  const isBidirectional = branchCount >= 2 || hasOpposingClaim(t);

  // 连续立场分：支持为正、反对为负，条件词只做阻尼、不贡献方向
  const stanceScore = Number(((support - oppose) / (support + oppose + condStrength * 0.3 + 1)).toFixed(3));

  const dominant = Math.max(support, oppose);
  const condQualified =
    condStrength >= COND_MIN_SCORE && condStrength >= dominant * COND_DOMINANCE && condStrength >= insufficient;

  let best;
  let bestN;
  if (condQualified) {
    // 条件信号成立：方向留给 stanceScore 表达，此处只标「带前提」
    best = 'conditional';
    bestN = cond;
  } else if (support !== oppose) {
    best = support > oppose ? 'support' : 'oppose';
    bestN = Math.max(support, oppose);
  } else if (insufficient > 0) {
    best = 'insufficient';
    bestN = insufficient;
  } else if (support > 0) {
    best = 'support';
    bestN = support;
  } else {
    best = 'insufficient';
    bestN = insufficient;
  }
  const confidence = Number((bestN / total).toFixed(2));
  const stance = isBidirectional
    ? 'mixed'
    : support === 0 && oppose === 0
      ? (insufficient > 0 ? 'uncertain' : 'neutral')
      : support > oppose
        ? 'support'
        : oppose > support
          ? 'oppose'
          : 'neutral';
  const conditionality = condQualified ? 'conditional' : cond > 0 ? 'unclear' : 'unconditional';
  const evidenceType = detectEvidenceType(t);
  return {
    cluster: best,
    stance,
    conditionality,
    evidenceType,
    condition: extractCondition(t, conditionality),
    stanceScore,
    confidence,
    support,
    oppose,
    isBidirectional,
    classificationMethod: 'rules',
    needsHumanReview: confidence < 0.55 || stance === 'mixed' || stance === 'uncertain' || evidenceType === 'unclear',
  };
}

// 热度分：只表达社区热度，与扎实度解耦
function heatScore(it) {
  const raw = Math.log1p(it.voteupCount || 0) / Math.log1p(20000);
  return Number(Math.min(1, raw).toFixed(3));
}

// 证据/材料完整度：基于权威度、是否含数据信号、正文长度
function hasDataSignal(text) {
  return /[0-9]/.test(text) || /(研究|数据|调查|报告|央行|行业|追踪|统计)/.test(text);
}
function evidenceCompleteness(it) {
  const auth = Math.max(0, Math.min(1, (Number(it.authorityLevel) - 1) / 4));
  const data = hasDataSignal(it.excerpt + ' ' + (it.featuredComment || '')) ? 0.25 : 0;
  const len = Math.min(1, (it.excerpt?.length || 0) / 300);
  // 点赞不进入扎实度，仅作为独立热度分存在
  const score = auth * 0.55 + data * 0.25 + len * 0.2;
  return Number(Math.min(1, score).toFixed(3));
}

// 综合可信度：仅用于排序推荐，不用于坐标/大小/样式
function credibility(it, heat, evidence) {
  // 使用热度与扎实度的加权和，但不再驱动任何视觉通道
  return Number((evidence * 0.6 + heat * 0.4).toFixed(3));
}

export function cluster(items) {
  return items.map((it) => {
    const text = `${it.excerpt} ${it.featuredComment || ''}`;
    const classification = classifyText(text);
    const { cluster: c, stanceScore, confidence, isBidirectional } = classification;
    const heat = heatScore(it);
    const evidence = evidenceCompleteness(it);
    // 条件成立记录立场修饰侧，供布局决定 x 落在哪一侧
    // stanceScore 的分母恒为正，故其符号等价于净立场符号
    //
    // mixed 优先于方向判定：一旦识别出双向条件，就不再声称它属于某一侧，
    // 由布局落在分水岭带并用双向标记表达，避免把复杂回答压缩成单一立场。
    let conditionalSide = null;
    if (c === 'conditional') {
      if (isBidirectional) conditionalSide = 'mixed';
      else if (stanceScore > SIDE_EPSILON) conditionalSide = 'support';
      else if (stanceScore < -SIDE_EPSILON) conditionalSide = 'oppose';
      else conditionalSide = 'neutral';
    }
    return {
      ...it,
      // 原始回答正文和来源始终保留，分类字段只作为可解释派生数据。
      originalText: it.originalText ?? it.excerpt ?? '',
      sourceId: it.id || '',
      sourceRef: sourceRefFromItem(it),
      cluster: c,
      stance: classification.stance,
      conditionality: classification.conditionality,
      evidenceType: classification.evidenceType,
      condition: classification.condition,
      evidenceExcerpt: it.featuredComment || it.excerpt || '',
      classificationMethod: classification.classificationMethod,
      needsHumanReview: classification.needsHumanReview,
      stanceScore,
      confidence,
      heatScore: heat,
      evidenceCompleteness: evidence,
      conditionalSide,
      credibility: credibility(it, heat, evidence),
    };
  });
}
