// mockData.js
// 示例数据（开发用，非真实知乎内容）。
// 结构严格对齐《开发者手册》中「知乎搜索」接口的返回字段：
//   标题 title / 摘要 excerpt / 作者 author / 发布时间 publishTime
//   相关性分数 relevanceScore(0-1) / 权威度等级 authorityLevel(1-5)
//   点赞数 voteupCount / 评论数 commentCount / 精选评论 featuredComment / 原文链接 url
// 真实环境由 ZhihuAdapter 从 GET /api/v1/content/zhihu_search 拉取，此处仅为离线开发占位。
// 每条演示条目均绑定到相关知乎问题页；条目正文和作者仍是演示内容，不能当作该问题页的真实回答（收藏夹引用同一显示结构）。
// 语料替换（manifest 思路，见 data/mock-manifest.example.json）：演示语料集中在本文件，
// 更换/下线语料直接编辑本文件即可；若后续数据量增大，可抽取为 JSON 并按样例结构加载。

export const AUTHORITY_LABELS = {
  1: '普通用户',
  2: '活跃用户',
  3: '优秀答主',
  4: '领域认证',
  5: '官方/机构',
};

// 三个争议性话题，覆盖「知识炼金场」典型场景：个人成长 / 职业 / 技术焦虑。
export const MOCK_TOPICS = [
  {
    id: 'save-money',
    demo: true,
    scenario: { id: 'learning-growth', label: '学习成长', shortLabel: '成长' },
    query: '年轻人是否应该尽早开始攒钱',
    items: [
      { id: 's1', title: '毕业三年存下第一桶金，我的几点体会', excerpt: '非常建议尽早开始攒钱，复利效应越早越好，哪怕每月只存收入的 10% 也很有必要。', author: '财经小白杨', publishTime: '2025-11-02', relevanceScore: 0.92, authorityLevel: 3, voteupCount: 12400, commentCount: 832, featuredComment: '存钱不是抠门，是给未来的自己留选择权。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's2', title: '年轻人别急着攒钱，先投资自己', excerpt: '反对把刚工作的钱都存起来，应该先花在学习和社交上，人力资本回报远高于利息。', author: '职场进化论', publishTime: '2025-10-18', relevanceScore: 0.88, authorityLevel: 4, voteupCount: 9800, commentCount: 654, featuredComment: '二十多岁最大的资产是时间和学习能力。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's3', title: '攒钱与否，关键看你的现金流结构', excerpt: '取决于收入和城市，如果在一线城市且收入不稳定，分场景看，先留足 6 个月应急金更务实。', author: '理性消费研究所', publishTime: '2025-09-30', relevanceScore: 0.85, authorityLevel: 4, voteupCount: 7300, commentCount: 421, featuredComment: '没有万能公式，视情况而定。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's4', title: '关于攒钱，我查了央行近十年居民储蓄数据', excerpt: '根据央行 2024 年调查，年轻群体储蓄率上升但分化明显，缺乏足够样本证明必须早存。', author: '数据观察者', publishTime: '2025-12-05', relevanceScore: 0.81, authorityLevel: 4, voteupCount: 5600, commentCount: 388, featuredComment: '数据只能说明趋势，无法给出定论。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's5', title: '我后悔没早点存钱', excerpt: '强烈建议所有人尽早开始，越早越好，等到急用钱时才发现没有底气，风险太大了。', author: '普通打工人', publishTime: '2025-08-21', relevanceScore: 0.78, authorityLevel: 1, voteupCount: 2100, commentCount: 156, featuredComment: '血泪教训。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's6', title: '攒钱焦虑正在制造新的消费主义对立', excerpt: '警惕把攒钱神话化，很多理财博主夸大收益，实际通胀下收益有限，需要更多独立判断。', author: '反割韭菜联盟', publishTime: '2025-11-20', relevanceScore: 0.74, authorityLevel: 3, voteupCount: 3400, commentCount: 277, featuredComment: '别被焦虑营销带节奏。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's7', title: '这取决于你的风险偏好和人生阶段', excerpt: '如果计划近期创业或深造，留现金更关键；如果工作稳定，定投同样可行，关键看目标。', author: '资产配置笔记', publishTime: '2025-10-09', relevanceScore: 0.71, authorityLevel: 4, voteupCount: 4500, commentCount: 210, featuredComment: '因人而异，没有标准答案。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's8', title: '关于「该不该攒钱」我还没有结论', excerpt: '样本太小且个体差异常大，暂时没有定论，需要更多 longitudinal 研究才能下判断。', author: '匿名用户', publishTime: '2025-07-15', relevanceScore: 0.62, authorityLevel: 1, voteupCount: 680, commentCount: 73, featuredComment: '看再多也难替自己做决定。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's9', title: '存钱是成年人最基础的自律', excerpt: '必须承认攒钱的重要性，它能让你在失业或生病时有缓冲，越早建立习惯越好。', author: '自律成长营', publishTime: '2025-09-03', relevanceScore: 0.69, authorityLevel: 2, voteupCount: 1900, commentCount: 98, featuredComment: '自律即自由。', url: 'https://www.zhihu.com/question/434965795' },
      { id: 's10', title: '别被「越早越好」裹挟', excerpt: '反对盲目早存，年轻时适度消费提升生活质量同样重要，关键是比例而非绝对额。', author: '生活平衡派', publishTime: '2025-12-12', relevanceScore: 0.66, authorityLevel: 2, voteupCount: 2600, commentCount: 141, featuredComment: '钱是工具不是目的。', url: 'https://www.zhihu.com/question/434965795' },
    ],
    directAnswer: {
      answer: '关于「年轻人是否应尽早攒钱」，社区没有统一结论。支持方强调复利与应急缓冲（财经小白杨、自律成长营）；反对方认为应先投资自己的人力资本（职场进化论）。更务实的观点是按现金流结构分场景处理：先留应急金，再视收入稳定性决定储蓄比例（理性消费研究所）。',
      citations: [
        { id: 's1', author: '财经小白杨' },
        { id: 's2', author: '职场进化论' },
        { id: 's3', author: '理性消费研究所' },
      ],
    },
  },
  {
    id: 'ai-replace-dev',
    demo: true,
    scenario: { id: 'ai-society', label: 'AI / 社会争议', shortLabel: 'AI 争议' },
    query: 'AI 会不会取代程序员',
    items: [
      { id: 'a1', title: '做了十年开发，我的判断：替代的是重复劳动', excerpt: 'AI 会取代写 CRUD 和样板代码的岗位，但系统设计和架构判断仍需人，条件成立。', author: '后端老枪', publishTime: '2026-01-08', relevanceScore: 0.94, authorityLevel: 4, voteupCount: 15600, commentCount: 932, featuredComment: '工具越强，越考验使用者的能力上限。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a2', title: '我用一个 Agent 跑完了整个需求', excerpt: '已经在很大程度上取代初级开发，从需求到部署全自动，必须正视这个趋势了。', author: 'AI 实践者', publishTime: '2026-02-11', relevanceScore: 0.90, authorityLevel: 3, voteupCount: 11200, commentCount: 701, featuredComment: '效率提升是真实的。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a3', title: '取代论每年都有，这次不一样吗', excerpt: '取决于定义，如果指「写代码」会，如果指「理解业务做决策」短期不会，分场景看。', author: '技术望远镜', publishTime: '2025-12-29', relevanceScore: 0.87, authorityLevel: 4, voteupCount: 8300, commentCount: 512, featuredComment: '问题本身需要被拆解。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a4', title: '我们调研了 200 家企业的研发提效数据', excerpt: '据 2025 年行业报告，AI 让初级任务耗时下降 40%，但高级岗位需求反而上升，暂无定论说会全面取代。', author: '研发效能实验室', publishTime: '2026-01-22', relevanceScore: 0.83, authorityLevel: 5, voteupCount: 6700, commentCount: 433, featuredComment: '结构性变化，不是简单替代。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a5', title: '别慌，但也别装看不见', excerpt: '警惕「AI 无用论」和「AI 取代论」两种极端，真实情况是中间地带，需要更多理性讨论。', author: '冷静派', publishTime: '2026-02-03', relevanceScore: 0.79, authorityLevel: 3, voteupCount: 3900, commentCount: 288, featuredComment: '少一点恐慌，多一点准备。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a6', title: '我坚决反对「程序员将消失」', excerpt: '反对这种论调，软件复杂度只会更高，需求只会更多，人类工程师的角色在升级而非消失。', author: '代码信仰者', publishTime: '2025-11-17', relevanceScore: 0.76, authorityLevel: 3, voteupCount: 5200, commentCount: 367, featuredComment: '问题在变难，不是变少。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a7', title: '这件事我没有足够数据下结论', excerpt: '样本太小且技术迭代太快，难以判断三年后的形态，需要更多研究才能评估。', author: '观望者', publishTime: '2026-01-30', relevanceScore: 0.64, authorityLevel: 1, voteupCount: 910, commentCount: 88, featuredComment: '让子弹飞一会儿。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a8', title: '关键看你怎么定义「程序员」', excerpt: '如果指纯执行，风险很大；如果指解决问题的工程师，价值在上升，关键看能力结构。', author: '职业坐标系', publishTime: '2026-02-20', relevanceScore: 0.72, authorityLevel: 4, voteupCount: 4800, commentCount: 256, featuredComment: '角色在进化。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a9', title: '我的团队已经裁掉一半初级岗', excerpt: '很现实地说，基础编码外包和初级岗位确实在被压缩，这是正在发生的事实。', author: ' Tech Lead', publishTime: '2026-02-15', relevanceScore: 0.70, authorityLevel: 4, voteupCount: 6100, commentCount: 419, featuredComment: '冷暖自知。', url: 'https://www.zhihu.com/question/1972252087044796716' },
      { id: 'a10', title: '与其担心，不如尽早转型', excerpt: '建议把 AI 当杠杆而非对手，越早掌握越主动，必须主动拥抱而不是被动等待。', author: '成长型思维', publishTime: '2025-12-08', relevanceScore: 0.68, authorityLevel: 2, voteupCount: 2700, commentCount: 150, featuredComment: '工具是中性的。', url: 'https://www.zhihu.com/question/1972252087044796716' },
    ],
    directAnswer: {
      answer: '关于「AI 会不会取代程序员」，社区主流判断是「结构性替代」而非「全面消失」。AI 已取代大量重复编码与样板工作（AI 实践者、Tech Lead），但系统设计、业务理解与架构决策仍依赖人（后端老枪、代码信仰者）。研发效能数据显示初级任务耗时下降约 40%，高级岗位需求反而上升（研发效能实验室）。结论：角色在进化，关键在于把 AI 当杠杆。',
      citations: [
        { id: 'a1', author: '后端老枪' },
        { id: 'a4', author: '研发效能实验室' },
        { id: 'a9', author: ' Tech Lead' },
      ],
    },
  },
  {
    id: 'grad-vs-job',
    demo: true,
    scenario: { id: 'career-choice', label: '职业选择', shortLabel: '职业' },
    query: '考研和直接就业，哪个更值得',
    items: [
      { id: 'g1', title: '双非逆袭 985，读研改变了我的起点', excerpt: '非常值得，尤其对本科一般的人，读研是性价比很高的跳板，越早规划越好。', author: '逆袭学长', publishTime: '2025-09-12', relevanceScore: 0.91, authorityLevel: 3, voteupCount: 10200, commentCount: 720, featuredComment: '平台决定视野。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g2', title: '我后悔读了三年研', excerpt: '反对盲目考研，如果只是为了逃避就业，三年后可能更被动，风险不小，建议先想清楚。', author: '过来人血泪', publishTime: '2025-10-25', relevanceScore: 0.88, authorityLevel: 3, voteupCount: 8800, commentCount: 605, featuredComment: '逃避解决不了问题。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g3', title: '取决于专业和院校层次', excerpt: '看情况，计算机本科就业强于普通硕士，而基础学科读研几乎必需，分场景决定。', author: '升学规划师', publishTime: '2025-11-09', relevanceScore: 0.86, authorityLevel: 4, voteupCount: 7400, commentCount: 489, featuredComment: '没有放之四海皆准的答案。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g4', title: '我们统计了同届 500 人的五年发展', excerpt: '据追踪调查，读研群体中期薪资更高但方差大，直接就业组更早积累行业资源，暂无定论谁更优。', author: '职业发展研究院', publishTime: '2025-12-18', relevanceScore: 0.82, authorityLevel: 5, voteupCount: 5900, commentCount: 377, featuredComment: '路径不同，终点难分高下。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g5', title: '先就业再考研，我两条路都走了', excerpt: '如果条件允许，建议工作一两年明确方向再读，比盲考更有针对性，关键看目标。', author: '折中主义', publishTime: '2025-08-30', relevanceScore: 0.78, authorityLevel: 2, voteupCount: 3300, commentCount: 201, featuredComment: '经验会让选择更清晰。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g6', title: '警惕「学历通胀」下的盲目内卷', excerpt: '反对把硕士当万能解药，很多岗位硕士红利正在消失，需要更多独立判断而非随大流。', author: '反内卷小组', publishTime: '2025-10-02', relevanceScore: 0.75, authorityLevel: 3, voteupCount: 4100, commentCount: 268, featuredComment: '别用别人的标准定义成功。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g7', title: '我还没想清楚，不急着下结论', excerpt: '样本太小且个体差异极大，暂时没有定论，需要结合家庭条件和行业再判断。', author: '迷茫的大四', publishTime: '2025-09-21', relevanceScore: 0.63, authorityLevel: 1, voteupCount: 760, commentCount: 82, featuredComment: '慢慢来比较快。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g8', title: '对科研型人格，读研是刚需', excerpt: '如果热爱研究，必须读，这是进入学术和前沿工业的门票，越早越好。', author: '学术搬砖', publishTime: '2025-11-28', relevanceScore: 0.70, authorityLevel: 4, voteupCount: 4600, commentCount: 233, featuredComment: '热爱是最好的理由。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g9', title: '家庭条件决定了你的选择权', excerpt: '取决于经济支撑，如果急需独立分担，先就业更现实；如果家庭允许，读研更从容。', author: '现实主义者', publishTime: '2025-12-01', relevanceScore: 0.73, authorityLevel: 2, voteupCount: 2900, commentCount: 174, featuredComment: '选择背后是资源。', url: 'https://www.zhihu.com/question/405883269' },
      { id: 'g10', title: '无论哪条路，执行力才是关键', excerpt: '反对把时间浪费在比较上，两条路都能成，关键是别停在犹豫里，必须行动起来。', author: '行动派', publishTime: '2025-10-14', relevanceScore: 0.67, authorityLevel: 2, voteupCount: 2200, commentCount: 129, featuredComment: '完成比完美重要。', url: 'https://www.zhihu.com/question/405883269' },
    ],
    directAnswer: {
      answer: '关于「考研还是直接就业」，社区强调「没有标准答案，取决于个体」。读研对本科一般或科研型人格是有效跳板（逆袭学长、学术搬砖），但盲目考研可能更被动（过来人血泪）。专业与院校层次是关键变量：计算机本科就业常强于普通硕士，基础学科读研近乎必需（升学规划师）。建议结合家庭资源与行业再判断。',
      citations: [
        { id: 'g1', author: '逆袭学长' },
        { id: 'g3', author: '升学规划师' },
        { id: 'g9', author: '现实主义者' },
      ],
    },
  },
];

// 演示收藏夹（B1 收藏夹校准的离线占位；真实环境由 user-api 拉取，OAuth 未部署时展示此演示数据）。
// 条目复用 MOCK_TOPICS 的内容（同一显示结构），避免重复造数据。
const pick = (topicId, ids) => {
  const topic = MOCK_TOPICS.find((t) => t.id === topicId);
  return ids.map((id) => topic.items.find((i) => i.id === id)).filter(Boolean);
};

export const MOCK_FAVORITES = [
  {
    urlToken: 1101,
    title: '职业选择',
    description: '考研 / 就业 / 攒钱 / 兴趣，我收藏的职场困惑',
    demo: true,
    items: [
      ...pick('grad-vs-job', ['g1', 'g3', 'g2', 'g6']),
      ...pick('save-money', ['s2', 's7']),
      ...pick('ai-replace-dev', ['a10']),
    ],
  },
  {
    urlToken: 1102,
    title: '技术焦虑',
    description: 'AI 与程序员的未来，我边焦虑边收藏',
    demo: true,
    items: [...pick('ai-replace-dev', ['a1', 'a2', 'a4', 'a6', 'a9', 'a7'])],
  },
];
