// app.js
// 装配层：输入 → 检索 → 融合 → 聚类 → 光谱 → 来源卡 → 观点成长卡。
// 游客直开主流程，OAuth 不阻塞；真实模式仅调用同源服务端代理。

import { MOCK_TOPICS, MOCK_FAVORITES } from './mockData.js';
import { createAdapter } from './adapter.js';
import { fuse } from './fusion.js';
import { cluster, CLUSTER_META } from './cluster.js';
import { applyClusterOverrides, selectAiClusterCandidates } from './ai-cluster.js';
import {
  ARGUMENT_META,
  ARGUMENT_ORDER,
  STANCE_META,
  STANCE_ORDER,
  argumentBucket,
  computeLayout,
  computeSummary,
  stanceBucket,
} from './spectrum.js';
import { generateChallenges, CHALLENGE_TYPES } from './challenge.js';
import { publicMessage } from './errors.js';
import { sanitizeSourceUrl } from './source.js';
import { selectRepresentativeSources, sourceSelectionSummary } from './source-selection.js';
import { buildKeyDisagreement } from './disagreement.js';
import { buildLearningCard } from './learning-card.js';
import { renderMarkdown } from './markdown.js';
import { sourceFocusButtonProps, sourceFocusStatusText } from './source-focus.js';
import { createResearchRun, updateInitialJudgment } from './research-run.js';
import { parseResearchState, snapshotResearchState } from './research-storage.js';
import { createRunController } from './run-lifecycle.js';
import { readingRecommendationLabel, selectReadingRecommendations } from './reading-recommendations.js';
import { buildRiskRecommendations, detectRisks, resolveRiskLevel } from './risk.js';

const adapter = createAdapter({
  mode: document.body.dataset.provider === 'http' || document.body.dataset.provider === 'cli' ? 'http' : 'mock',
  topics: MOCK_TOPICS,
  favorites: MOCK_FAVORITES,
});
const liveProvider = ['http', 'cli'].includes(document.body.dataset.provider);
const aiClusterEnabled = liveProvider && document.body.dataset.aiCluster === 'on';
const runController = createRunController();

const state = {
  items: [],
  layout: [],
  summary: null,
  userStance: null,
  draftStance: null,
  initialReason: '',
  judgmentLocked: false,
  openedSourceIds: new Set(),
  secondDraftStance: null,
  secondDraftReason: '',
  secondJudgment: null,
  secondFeedbackMessage: '',
  activeCluster: null,
  activeFilter: null,
  query: null,
  isDemo: true,
  aiClustered: false,
  primarySources: [],
  sourcesExpanded: false,
  sourceSelection: null,
  focusedSourceId: null,
  disagreement: null,
  learningCard: null,
  riskSignals: [],
  riskLevel: 'low',
  riskRecommendations: [],
  mode: 'topic', // 'topic' | 'favorites'
  view: 'home', // home | judgment | reading | sources | recheck | complete
  searchRunId: 0,
  researchRun: null,
  oauthConnected: false,
};

// 挑战类型 → 颜色（职能分工，非装饰：琥珀=不同方向，绿=成立条件，暗金=材料边界）
const CHALLENGE_COLOR = {
  blind_spot: '#D6681E',
  missing_condition: '#16806B',
  evidence_gap: '#8A6D1A',
};

const STANCE_LABEL = { support: '支持', oppose: '反对', neutral: '中立', mixed: '混合', uncertain: '不确定' };
const CONDITIONALITY_LABEL = { unconditional: '无条件', conditional: '有条件', unclear: '不明确' };
const EVIDENCE_LABEL = { data: '数据', professional_citation: '专业引用', personal_experience: '个人经验', lacking_evidence: '缺少证据', unclear: '不明确' };

const $ = (sel) => document.querySelector(sel);
const sourceKey = (id) => (id == null ? '' : String(id));
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (/^on[a-z]+$/i.test(k) && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'string') n.style.cssText = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'ariaLabel') n.setAttribute('aria-label', v);
    else if (k === 'ariaPressed') n.setAttribute('aria-pressed', v);
    else if (k === 'ariaLive') n.setAttribute('aria-live', v);
    else if (k === 'ariaHidden') n.setAttribute('aria-hidden', v);
    else n[k] = v;
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    n.append(c);
  }
  return n;
};

const VIEW_IDS = ['judgmentView', 'readingView', 'sourcesView', 'recheckView', 'completeView'];
const RESEARCH_STORAGE_KEY = 'zhibian:research-state:v1';

function pageIsDemo() {
  if (state.view === 'home' || !state.query) return !liveProvider;
  return Boolean(state.isDemo);
}

function dataStatus() {
  if (pageIsDemo()) {
    return {
      short: '演示数据',
      full: '演示数据 · 来源结构与真实体验一致',
      hot: '知乎热榜示例 · 演示',
      share: '演示数据',
    };
  }
  return {
    short: '知乎公开来源',
    full: '知乎公开来源 · 可打开原文核验',
    hot: '知乎热榜 · 实时来源',
    share: '知乎公开来源',
  };
}

function applyDataStatusCopy() {
  const copy = dataStatus();
  const demo = pageIsDemo();
  const guestBadge = document.querySelector('.guest-badge');
  if (guestBadge) {
    guestBadge.classList.toggle('hidden', state.oauthConnected);
    guestBadge.setAttribute('aria-hidden', state.oauthConnected ? 'true' : 'false');
  }
  const zhihuStatus = $('#zhihuStatus');
  if (zhihuStatus) {
    zhihuStatus.textContent = state.oauthConnected ? '知乎 · 已连接' : copy.short;
    zhihuStatus.classList.remove('hidden');
    zhihuStatus.classList.toggle('is-demo', !state.oauthConnected && demo);
    zhihuStatus.classList.toggle('is-live', state.oauthConnected || !demo);
  }
  const controlsNote = document.querySelector('.controls-note');
  const controlsHint = document.querySelector('.controls-hint');
  if (controlsHint) controlsHint.textContent = state.oauthConnected
    ? '体验你的收藏夹观点分析'
    : '体验收藏夹观点分析（预览）';
  if (controlsNote) controlsNote.textContent = state.oauthConnected
    ? '已连接知乎，将读取你授权范围内的公开收藏夹'
    : '登录知乎后可读取你授权范围内的公开收藏夹';
  const favPanelLabel = document.querySelector('#favPanelLabel');
  if (favPanelLabel) favPanelLabel.textContent = state.oauthConnected
    ? '选择一个收藏夹，查看其中可分析的知乎内容：'
    : '选择一个演示收藏夹，查看观点分析预览：';
  const footerDataStatus = $('#footerDataStatus');
  if (footerDataStatus) footerDataStatus.textContent = copy.full;
  const progressBadge = $('#dataProgressBadge');
  if (progressBadge) {
    progressBadge.textContent = copy.short;
    progressBadge.classList.toggle('is-live', !demo);
  }
  const hotLabel = $('#hotLabel');
  if (hotLabel && state.view === 'home') hotLabel.textContent = copy.hot;
}

async function refreshOAuthStatus() {
  if (!liveProvider) return;
  try {
    // 使用相对路径，避免代理路径被重复拼接。
    const response = await fetch('api/zhihu/me/favlists?limit=1', { cache: 'no-store' });
    state.oauthConnected = response.ok;
  } catch {
    state.oauthConnected = false;
  }
  applyDataStatusCopy();
  if (state.oauthConnected) setStatus('知乎已连接 · 可直接体验，并可读取授权范围内的公开收藏夹');
}

function syncSearchButton() {
  const btn = $('#searchBtn');
  const input = $('#q');
  if (!btn || !input) return;
  btn.disabled = !input.value.trim();
}

function stanceChoiceButtons({ selected, onSelect, disabled = false, ariaLabel }) {
  const choices = el('div', { className: 'judgment-options', role: 'group', ariaLabel });
  const icons = { support: '▲', neutral: '—', oppose: '▼' };
  for (const value of STANCE_ORDER) {
    const active = selected === value;
    const iconColor = CLUSTER_META[value] ? CLUSTER_META[value].color : 'var(--ink-soft)';
    const btn = el('button', {
      type: 'button',
      disabled,
      className: 'stance-card' + (active ? ' active' : ''),
      dataset: { stance: value },
      ariaPressed: active ? 'true' : 'false',
      onclick: () => { if (!disabled) onSelect(value); },
    });
    btn.append(el('span', { className: 'stance-card-icon', style: `color:${iconColor}`, textContent: icons[value] }));
    btn.append(el('span', { className: 'stance-card-label', textContent: STANCE_META[value].label }));
    if (active) btn.append(el('span', { className: 'stance-card-check', ariaHidden: 'true', textContent: '✓' }));
    choices.append(btn);
  }
  return choices;
}

function clearPersistedResearchState() {
  try { window.localStorage.removeItem(RESEARCH_STORAGE_KEY); } catch { /* 隐私模式或禁用存储时不阻断主流程 */ }
}

function persistResearchState() {
  const snapshot = snapshotResearchState(state);
  if (!snapshot) return;
  try { window.localStorage.setItem(RESEARCH_STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* 本地存储失败不阻断主流程 */ }
}

function restorePersistedResearchState() {
  let raw = null;
  try { raw = window.localStorage.getItem(RESEARCH_STORAGE_KEY); } catch { return false; }
  const saved = parseResearchState(raw);
  if (!saved) {
    if (raw) clearPersistedResearchState();
    return false;
  }
  state.items = saved.items;
  state.mode = saved.mode;
  state.isDemo = saved.isDemo;
  state.query = saved.researchRun.topic;
  state.userStance = saved.userStance;
  state.initialReason = saved.initialReason;
  state.openedSourceIds = new Set(saved.openedSourceIds);
  state.secondJudgment = saved.secondJudgment;
  state.judgmentLocked = true;
  state.researchRun = saved.researchRun;
  state.primarySources = selectRepresentativeSources(state.items);
  state.sourceSelection = sourceSelectionSummary(state.items, state.primarySources);
  state.disagreement = buildKeyDisagreement(state.items);
  state.learningCard = buildLearningCard(state.items, { userStance: state.userStance });
  updateRiskState(state.items);
  state.layout = computeLayout(state.items);
  state.summary = computeSummary(state.items);
  state.sourcesExpanded = false;
  $('#homeScreen')?.classList.add('hidden');
  $('#results')?.classList.remove('hidden');
  const journeyTitle = $('#journeyTitle');
  if (journeyTitle) journeyTitle.textContent = state.query;
  renderAll();
  showView(state.secondJudgment ? 'complete' : 'reading');
  setStatus('已恢复上次研究记录 · 仅保存在本浏览器本地');
  return true;
}

function showView(view) {
  const target = document.getElementById(`${view}View`);
  if (!target) return;
  if (view === 'judgment') {
    // 回到第一站时重新挂载表态控件，保留已选立场和理由，避免只显示一个空白页面。
    renderJudgmentLock();
    $('#judgmentLock')?.classList.remove('hidden');
  }
  if (view === 'recheck') renderSecondJudgmentScreen();
  syncRecheckBackLink();
  state.view = view;
  for (const id of VIEW_IDS) document.getElementById(id)?.classList.add('hidden');
  target.classList.remove('hidden');
  document.body.dataset.view = view;
  updateStageBar();
  // Expose controls immediately after a view transition. Smooth scrolling
  // races with the first click on the newly-rendered stance buttons.
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function showHome() {
  state.searchRunId = runController.invalidate();
  resetRunScopedState();
  resetResultView();
  state.view = 'home';
  $('#homeScreen')?.classList.remove('hidden');
  $('#results')?.classList.add('hidden');
  for (const id of VIEW_IDS) document.getElementById(id)?.classList.add('hidden');
  document.body.dataset.view = 'home';
  setStatus('准备启航，先写下你想核对的问题。');
  // The click handler owns navigation, so remove an existing #about fragment
  // instead of leaving the address bar on a stale footer anchor.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  applyDataStatusCopy();
}

function settleWithin(promise, timeoutMs = 4500) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- 主流程 ----------
async function runSearch(query, { simulateEmpty = false } = {}) {
  const run = runController.beginSearch();
  const runId = run.id;
  state.searchRunId = runId;
  $('#homeScreen')?.classList.add('hidden');
  $('#results')?.classList.remove('hidden');
  resetRunScopedState();
  clearPersistedResearchState();
  state.query = query;
  state.mode = 'topic';
  resetResultView();
  const journeyTitle = $('#journeyTitle');
  if (journeyTitle) journeyTitle.textContent = query;
  setStatus('正在捞取社区讨论…');
  const res = await adapter.search(query, { forceEmpty: simulateEmpty, signal: run.signal }).catch(() => ({ ok: false, empty: true, reason: 'network_error' }));
  if (runId !== state.searchRunId) return;
  const resultsEl = $('#results');
  if (!res.ok || res.empty) {
    state.isDemo = Boolean(res.demo);
    state.aiClustered = false;
    resultsEl.classList.remove('hidden');
    renderDowngrade(res);
    return;
  }
  setStatus('正在分辨不同经验…');
  const fused = fuse(res.items);
  const ruleClustered = cluster(fused);
  let clustered = ruleClustered;
  state.aiClustered = false;
  const aiCandidates = selectAiClusterCandidates(ruleClustered);
  if (aiClusterEnabled && aiCandidates.length && typeof adapter.classify === 'function') {
    setStatus('正在用知乎直答校准观点分组…');
    const ai = await settleWithin(adapter.classify(aiCandidates, { signal: run.signal }).catch(() => null));
    if (runId !== state.searchRunId) return;
    if (ai?.ok) {
      clustered = applyClusterOverrides(ruleClustered, ai.items);
      state.aiClustered = clustered.some((item) => item.aiClustered);
    }
  }
  state.items = clustered;
  state.primarySources = selectRepresentativeSources(clustered);
  state.sourceSelection = sourceSelectionSummary(clustered, state.primarySources);
  state.disagreement = buildKeyDisagreement(clustered);
  state.learningCard = buildLearningCard(clustered, { userStance: state.userStance });
  updateRiskState(clustered);
  state.sourcesExpanded = false;
  state.layout = computeLayout(clustered);
  state.summary = computeSummary(clustered);
  state.researchRun = createResearchRun({
    runId: `topic-${runId}`,
    mode: 'topic',
    topic: query,
    isDemo: Boolean(res.demo),
    items: clustered,
  });
  state.activeCluster = null;
  state.activeFilter = null;
  state.isDemo = Boolean(res.demo);
  prepareJudgmentLock();
  $('#daResult').innerHTML = '';
  setStatus(`${pageIsDemo() ? '演示数据 · ' : ''}已发现 ${clustered.length} 条可回看的知乎讨论 · 请先锁定判断`);
}

function renderAll() {
  $('#results').classList.remove('hidden');
  renderSpectrum(state.layout);
  renderSummary(state.summary);
  renderSourceList(state.items);
  renderSourceTeaser();
  renderGrowthCard();
  renderSecondJudgmentScreen();
  renderCompletionView();
  updateStageBar();
  // 数据状态徽章：真实通道也必须显式标记，避免用户误把实时结果当成演示数据。
  renderDataBadge(true);
}

function renderDataBadge(visible) {
  const badge = $('#demoBadge');
  const copy = dataStatus();
  if (badge) {
    badge.textContent = visible ? copy.full : '';
    badge.classList.toggle('hidden', !visible);
    badge.classList.toggle('is-live', visible && !pageIsDemo());
  }
  applyDataStatusCopy();
}

function updateRiskState(items) {
  const texts = (Array.isArray(items) ? items : []).map((item) => `${item?.excerpt || ''} ${item?.featuredComment || ''}`);
  state.riskSignals = detectRisks(items, texts);
  state.riskLevel = resolveRiskLevel(state.riskSignals);
  state.riskRecommendations = buildRiskRecommendations(state.riskSignals, items);
}

function resetJudgment() {
  state.userStance = null;
  state.draftStance = null;
  state.initialReason = '';
  state.judgmentLocked = false;
  state.openedSourceIds = new Set();
  state.primarySources = [];
  state.sourcesExpanded = false;
  state.sourceSelection = null;
  state.focusedSourceId = null;
  state.disagreement = null;
  state.learningCard = null;
  state.riskSignals = [];
  state.riskLevel = 'low';
  state.riskRecommendations = [];
  state.researchRun = null;
  state.secondDraftStance = null;
  state.secondDraftReason = '';
  state.secondJudgment = null;
  state.secondFeedbackMessage = '';
}

function resetRunScopedState() {
  resetJudgment();
  state.items = [];
  state.layout = [];
  state.summary = null;
  state.activeCluster = null;
  state.activeFilter = null;
  state.query = null;
  state.isDemo = true;
  state.aiClustered = false;
  state.mode = 'topic';
}

function resetResultView() {
  $('#results')?.classList.add('hidden');
  $('#judgmentLock')?.classList.add('hidden');
  $('#downgradePanel')?.classList.add('hidden');
  $('#shareCardBox')?.classList.add('hidden');
  $('#compare')?.classList.add('hidden');
  const title = $('#journeyTitle');
  if (title) title.textContent = '';
  $('#daResult')?.replaceChildren();
  renderDataBadge(false);
  for (const id of VIEW_IDS) document.getElementById(id)?.classList.add('hidden');
}

function prepareJudgmentLock() {
  $('#results').classList.remove('hidden');
  $('#downgradePanel').classList.add('hidden');
  renderJudgmentLock();
  renderDataBadge(true);
  showView('judgment');
}

function renderJudgmentLock(message = '') {
  const wrap = $('#judgmentLock');
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  wrap.append(
    el('p', { className: 'panel-kicker', textContent: '第一站 · 启航前' }),
    el('h2', { textContent: '先表态' }),
    el('p', { className: 'lock-copy', textContent: '别人的话先不看。你自己的判断，才是最重要的对照组。' }),
  );
  const topic = el('div', { className: 'lock-topic' }, [el('span', { className: 'lock-topic-label', textContent: '话题' }), el('span', { className: 'lock-topic-name', textContent: state.query || '示例话题' })]);
  wrap.append(topic);

  const choices = stanceChoiceButtons({
    selected: state.draftStance,
    ariaLabel: '选择初始立场',
    onSelect: (value) => { state.draftStance = value; renderJudgmentLock(); },
  });
  const reasonId = 'initialReason';
  const reason = el('textarea', {
    id: reasonId,
    rows: 3,
    placeholder: '可选：我为什么这么看？（例如：钱要趁早攒，复利靠时间。）',
    value: state.initialReason,
    oninput: (event) => { state.initialReason = event.target.value; },
  });
  const lockButton = el('button', {
    type: 'button',
    className: 'primary lock-btn',
    disabled: !state.draftStance,
    textContent: '锁定我的初始判断',
    onclick: lockJudgment,
  });
  wrap.append(
    choices,
    el('label', { className: 'reason-label', htmlFor: reasonId, textContent: '我为什么这么看？（可选）' }),
    reason,
    lockButton,
    el('p', { className: 'inline-status', role: 'status', ariaLive: 'polite', textContent: message }),
  );
}

function lockJudgment() {
  if (!state.draftStance) {
    renderJudgmentLock('请选择支持、中立或反对，再启航。');
    return;
  }
  state.userStance = state.draftStance;
  state.initialReason = state.initialReason.trim();
  state.learningCard = buildLearningCard(state.items, { userStance: state.userStance });
  if (state.researchRun) {
    state.researchRun = updateInitialJudgment(state.researchRun, {
      stance: state.userStance,
      reason: state.initialReason,
    });
  }
  state.judgmentLocked = true;
  persistResearchState();
  $('#judgmentLock').classList.add('hidden');
  renderAll();
  showView('reading');
  $('#compare').classList.add('hidden');
  setStatus(`${pageIsDemo() ? '演示数据 · ' : ''}${state.aiClustered ? 'AI 辅助分组 · ' : ''}已发现 ${state.items.length} 条可回看的知乎讨论 · 船已驶入观点海域`);
}

// ---------- 观点海图 SVG（确定性渲染） ----------
function renderSpectrum(layout) {
  const W = 800, H = 420, padX = 70, padY = 46;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'spectrum');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '知乎讨论观点海图，横向从反对到支持，纵向表示证据可核验程度，浮标大小表示点赞热度');
  const svgTitle = document.createElementNS(svgNS, 'title');
  svgTitle.textContent = '知乎讨论观点海图';
  svg.append(svgTitle);
  const xMap = (x) => padX + ((x + 1) / 2) * (W - 2 * padX);
  const yMap = (y) => H - padY - y * (H - 2 * padY);

  // 水域背景渐变
  const defs = document.createElementNS(svgNS, 'defs');
  const grad = document.createElementNS(svgNS, 'linearGradient');
  grad.setAttribute('id', 'sea-gradient');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const stop1 = document.createElementNS(svgNS, 'stop');
  stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', '#EAF5FA');
  const stop2 = document.createElementNS(svgNS, 'stop');
  stop2.setAttribute('offset', '55%'); stop2.setAttribute('stop-color', '#B6E0EE');
  const stop3 = document.createElementNS(svgNS, 'stop');
  stop3.setAttribute('offset', '100%'); stop3.setAttribute('stop-color', '#8FCFE3');
  grad.append(stop1, stop2, stop3);
  defs.append(grad);
  svg.append(defs);

  const seaRect = document.createElementNS(svgNS, 'rect');
  seaRect.setAttribute('width', W); seaRect.setAttribute('height', H);
  seaRect.setAttribute('fill', 'url(#sea-gradient)');
  seaRect.setAttribute('rx', '12');
  svg.append(seaRect);

  // 观点区域（渔区 / 雾区）
  // 注意：「条件成立」不是独立区域，而是立场的修饰，跟随支持/反对左右分布，
  // 只用虚线环 + 菱形徽记在浮标上表达，不再占用固定中央区域。
  const zone = (cx, cy, rx, ry, cls) => {
    const el = document.createElementNS(svgNS, 'ellipse');
    el.setAttribute('cx', cx); el.setAttribute('cy', cy);
    el.setAttribute('rx', rx); el.setAttribute('ry', ry);
    el.setAttribute('class', cls);
    svg.append(el);
  };
  zone(xMap(-0.55), yMap(0.38), 120, 150, 'zone-oppose');
  zone(xMap(0.55), yMap(0.42), 135, 165, 'zone-support');
  zone(xMap(0), yMap(0.1), 300, 52, 'zone-insufficient');

  // 分水岭带：方向不明 / 双向条件的落位区
  // 条件成立一旦无法归属到任一侧（或本身就是双向），必须落在这一带，
  // 而不是被硬塞进左右渔区——这是「不把复杂回答误读成单一立场」的视觉兜底。
  // 宽度与 spectrum.js 里 mixed 的夹取范围（±0.16）保持一致。
  const WATERSHED_HALF = 0.16;
  const band = document.createElementNS(svgNS, 'rect');
  band.setAttribute('x', xMap(-WATERSHED_HALF));
  band.setAttribute('y', padY);
  band.setAttribute('width', xMap(WATERSHED_HALF) - xMap(-WATERSHED_HALF));
  band.setAttribute('height', H - 2 * padY);
  band.setAttribute('class', 'watershed-band');
  svg.append(band);
  // 两侧虚线边，让「带」有明确边界而不是一团模糊的水色
  for (const sx of [-WATERSHED_HALF, WATERSHED_HALF]) {
    const edge = document.createElementNS(svgNS, 'line');
    edge.setAttribute('x1', xMap(sx)); edge.setAttribute('x2', xMap(sx));
    edge.setAttribute('y1', padY); edge.setAttribute('y2', H - padY);
    edge.setAttribute('class', 'watershed-edge');
    svg.append(edge);
  }

  // 区域标签
  const zoneLabel = (txt, cx, cy, cls) => {
    const t = document.createElementNS(svgNS, 'text');
    t.setAttribute('x', cx); t.setAttribute('y', cy); t.setAttribute('class', cls);
    t.textContent = txt; svg.append(t);
  };
  zoneLabel('支持渔区', xMap(0.55), yMap(0.55) - 88, 'zone-label support');
  zoneLabel('反对渔区', xMap(-0.55), yMap(0.35) - 78, 'zone-label oppose');
  zoneLabel('证据不足雾区', xMap(0), yMap(0.14) - 50, 'zone-label insufficient');
  zoneLabel('分水岭 · 方向不明 / 双向条件', xMap(0), padY - 14, 'zone-label watershed');

  // 轴线
  const axis = document.createElementNS(svgNS, 'line');
  axis.setAttribute('x1', padX); axis.setAttribute('x2', W - padX);
  axis.setAttribute('y1', yMap(0)); axis.setAttribute('y2', yMap(0));
  axis.setAttribute('class', 'axis-base');
  svg.append(axis);
  const mid = document.createElementNS(svgNS, 'line');
  mid.setAttribute('x1', xMap(0)); mid.setAttribute('x2', xMap(0));
  mid.setAttribute('y1', padY); mid.setAttribute('y2', H - padY);
  mid.setAttribute('class', 'axis-mid');
  svg.append(mid);

  const label = (txt, x, y, cls) => {
    const t = document.createElementNS(svgNS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('class', cls);
    t.textContent = txt; svg.append(t);
  };
  label('← 反对', padX - 6, H - padY + 24, 'axis-label left');
  label('支持 →', W - padX + 6, H - padY + 24, 'axis-label right');
  // 顶部中央让给「分水岭带」标签，纵轴说明移到左上
  label('↑ 可核验程度', padX - 6, padY - 14, 'axis-label left');

  // 浮标节点
  for (const node of layout) {
    const cx = xMap(node.x), cy = yMap(node.y);
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'node');
    g.setAttribute('role', 'button');
    g.setAttribute('tabindex', '0');
    const conditionalLabel = node.conditionalSide === 'mixed'
      ? '双向条件，方向不明'
      : node.conditionalSide === 'support'
        ? '带前提的支持'
        : node.conditionalSide === 'oppose'
          ? '带前提的反对'
          : '方向不明的条件';
    g.setAttribute('aria-label', `查看讨论：${node.item.title}${node.cluster === 'conditional' ? `（${conditionalLabel}）` : ''}`);
    g.dataset.id = node.id;
    g.addEventListener('click', () => viewSource(node.id));
    g.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        viewSource(node.id);
      }
    });

    // 主浮标
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy);
    c.setAttribute('r', node.size);
    c.setAttribute('fill', node.color);
    c.setAttribute('fill-opacity', node.fillOpacity.toFixed(2));
    c.setAttribute('stroke', node.color);
    c.setAttribute('stroke-width', node.strokeWidth.toFixed(2));
    g.append(c);

    // 条件成立：位置跟随立场分布在左右，形态区分三种语义
    //   support/oppose → 虚线环 + 菱形徽记（带前提，但有明确方向）
    //   mixed          → 左右双色环 + 双向箭头（两边都成立，不归属任一侧）
    //   neutral        → 只有虚线环（方向不明）
    if (node.cluster === 'conditional') {
      const rr = node.size + 5;
      const ring = document.createElementNS(svgNS, 'circle');
      ring.setAttribute('cx', cx); ring.setAttribute('cy', cy);
      ring.setAttribute('r', rr);
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', node.color);
      ring.setAttribute('stroke-width', '1.5');
      ring.setAttribute('stroke-dasharray', '4 3');
      ring.setAttribute('opacity', '0.8');
      g.append(ring);

      if (node.conditionalSide === 'mixed') {
        // 左右双色半环：右半用支持蓝、左半用反对橙，
        // 直观表达「这条回答两边都成立」，而非中性灰。
        const halfRing = (sweep, color) => {
          const arc = document.createElementNS(svgNS, 'path');
          arc.setAttribute('d', `M ${cx} ${cy - rr} A ${rr} ${rr} 0 0 ${sweep} ${cx} ${cy + rr}`);
          arc.setAttribute('fill', 'none');
          arc.setAttribute('stroke', color);
          arc.setAttribute('stroke-width', '2.5');
          arc.setAttribute('stroke-linecap', 'butt');
          g.append(arc);
        };
        // 取 CLUSTER_META 而非写死色值：簇颜色改一处即可，不会与图例/分享图卡漂移
        halfRing(1, CLUSTER_META.support.color);   // 右半 = 支持侧
        halfRing(0, CLUSTER_META.oppose.color);    // 左半 = 反对侧

        // 双向箭头：覆在环上方，一眼区别于单向条件
        const ay = cy - rr - 7;
        const half = node.size * 0.85;
        const shaft = document.createElementNS(svgNS, 'line');
        shaft.setAttribute('x1', cx - half); shaft.setAttribute('x2', cx + half);
        shaft.setAttribute('y1', ay); shaft.setAttribute('y2', ay);
        shaft.setAttribute('stroke', CLUSTER_META.conditional.color);
        shaft.setAttribute('stroke-width', '2');
        g.append(shaft);
        for (const dir of [-1, 1]) {
          const tipX = cx + dir * half;
          const head = document.createElementNS(svgNS, 'polygon');
          head.setAttribute('points',
            `${tipX},${ay} ${tipX - dir * 6},${ay - 4} ${tipX - dir * 6},${ay + 4}`);
          head.setAttribute('fill', CLUSTER_META.conditional.color);
          g.append(head);
        }
        g.setAttribute('aria-label', `${g.getAttribute('aria-label')}（双向条件：两边都成立，取决于前提）`);
      } else if (node.conditionalSide === 'support' || node.conditionalSide === 'oppose') {
        // 菱形徽记：右上角的旋转方块，一眼区分「带前提」与普通浮标
        const bx = cx + node.size * 0.52;
        const by = cy - node.size * 0.52 - 8;
        const badge = document.createElementNS(svgNS, 'rect');
        badge.setAttribute('x', bx);
        badge.setAttribute('y', by);
        badge.setAttribute('width', 9);
        badge.setAttribute('height', 9);
        badge.setAttribute('fill', node.color);
        badge.setAttribute('stroke', '#FFFFFF');
        badge.setAttribute('stroke-width', '1.5');
        badge.setAttribute('transform', `rotate(45 ${bx + 4.5} ${by + 4.5})`);
        g.append(badge);
      }

      // 注：曾在浮标内部画过白色小箭头表达双向，已移除——白色在半透明填充上
      // （evidenceCompleteness 低时 fillOpacity 仅 0.25）几乎不可见，
      // 且与上方的双色环 + 双向箭头重复。双向语义统一由上方那组标记表达。
    }

    // 灯塔：高权威 / 高证据来源
    if (node.isLighthouse) {
      const lg = document.createElementNS(svgNS, 'g');
      lg.setAttribute('class', 'lighthouse');
      const body = document.createElementNS(svgNS, 'rect');
      body.setAttribute('x', cx - 6); body.setAttribute('y', cy - node.size - 26);
      body.setAttribute('width', 12); body.setAttribute('height', 22);
      body.setAttribute('fill', '#0A3D62');
      body.setAttribute('rx', '2');
      lg.append(body);
      const light = document.createElementNS(svgNS, 'circle');
      light.setAttribute('cx', cx); light.setAttribute('cy', cy - node.size - 28);
      light.setAttribute('r', 5);
      // 灯光刻意不用 --dispute（反对橙）：橙色在本图已绑定「反对簇」，
      // 用作灯光会被误读成「这条来源站反对侧」，而灯塔只表示权威性、与立场无关。
      light.setAttribute('fill', '#FFC94D');
      lg.append(light);
      svg.append(lg);
    }

    const title = document.createElementNS(svgNS, 'title');
    // 显示决定尺寸的那个值（visualHeat 是话题内相对热度），而不是原始 heatScore——
    // 否则会出现「数字写 0.15、浮标却很大」的自相矛盾。赞同数是可审计的原始事实，一并给出。
    title.textContent = `${node.item.title}（立场 ${STANCE_META[stanceBucket(node.item)].label} · ${ARGUMENT_META[argumentBucket(node.item)].label}${node.conditionalSide === 'mixed' ? ' · 双向条件' : ''} · 话题内热度 ${node.visualHeat} · 赞同 ${node.item.voteupCount} · 扎实度 ${node.evidenceCompleteness}）`;
    g.append(title);
    if (node.cluster === 'conditional' || node.cluster === 'insufficient') {
      const kind = document.createElementNS(svgNS, 'text');
      kind.setAttribute('x', cx);
      kind.setAttribute('y', cy + 4);
      kind.setAttribute('class', 'node-kind-label');
      kind.setAttribute('text-anchor', 'middle');
      kind.textContent = node.cluster === 'conditional' ? '条件' : '不足';
      g.append(kind);
    }
    svg.append(g);
  }

  // 用户的船
  if (state.userStance) {
    const stanceXMap = { support: 0.55, neutral: 0, oppose: -0.55 };
    const bx = xMap(stanceXMap[state.userStance]);
    const by = yMap(0.22);
    const boatG = document.createElementNS(svgNS, 'g');
    boatG.setAttribute('class', 'user-boat');
    const hull = document.createElementNS(svgNS, 'path');
    hull.setAttribute('d', `M${bx - 18},${by} L${bx + 18},${by} L${bx + 14},${by + 14} L${bx - 14},${by + 14} Z`);
    hull.setAttribute('fill', '#0A3D62');
    boatG.append(hull);
    const sail = document.createElementNS(svgNS, 'path');
    sail.setAttribute('d', `M${bx},${by - 22} L${bx + 12},${by - 2} L${bx - 12},${by - 2} Z`);
    sail.setAttribute('fill', '#FFFFFF');
    sail.setAttribute('stroke', '#0A3D62');
    sail.setAttribute('stroke-width', '1.5');
    boatG.append(sail);
    const mast = document.createElementNS(svgNS, 'line');
    mast.setAttribute('x1', bx); mast.setAttribute('y1', by - 22);
    mast.setAttribute('x2', bx); mast.setAttribute('y2', by);
    mast.setAttribute('stroke', '#0A3D62');
    mast.setAttribute('stroke-width', '2');
    boatG.append(mast);

    const stanceLabel = { support: '支持', neutral: '中立', oppose: '反对' }[state.userStance];
    const boatLabel = document.createElementNS(svgNS, 'text');
    boatLabel.setAttribute('x', bx); boatLabel.setAttribute('y', by + 28);
    boatLabel.setAttribute('class', 'boat-label');
    boatLabel.textContent = `你的船 · ${stanceLabel}`;
    boatG.append(boatLabel);

    if (state.openedSourceIds.size) {
      const readLabel = document.createElementNS(svgNS, 'text');
      readLabel.setAttribute('x', bx); readLabel.setAttribute('y', by + 42);
      readLabel.setAttribute('class', 'boat-read');
      readLabel.textContent = `已尝试打开 ${state.openedSourceIds.size}/${state.items.length} 来源`;
      boatG.append(readLabel);
    }
    svg.append(boatG);

    // 航线：从船到最近一条已尝试打开来源
    if (state.openedSourceIds.size) {
      let lastReadId = null;
      for (const id of state.openedSourceIds) lastReadId = id;
      const target = layout.find((n) => sourceKey(n.id) === sourceKey(lastReadId));
      if (target) {
        const tx = xMap(target.x), ty = yMap(target.y);
        const route = document.createElementNS(svgNS, 'line');
        route.setAttribute('x1', bx); route.setAttribute('y1', by);
        route.setAttribute('x2', tx); route.setAttribute('y2', ty);
        route.setAttribute('class', 'route-line');
        // 插到船之前，避免船被航线压住
        svg.insertBefore(route, boatG);
      }
    }
  }

  const wrap = $('#spectrum');
  wrap.innerHTML = '';
  wrap.append(svg);
}

// ---------- 航线分布 ----------
function renderSummary(summary) {
  const wrap = $('#summary');
  const stanceCounts = summary?.stanceCounts || { support: 0, neutral: 0, oppose: 0 };
  const argumentCounts = summary?.argumentCounts || { direct: 0, conditional: 0, insufficient: 0 };
  const legendCounts = {
    supportLegendCount: stanceCounts.support,
    neutralLegendCount: stanceCounts.neutral,
    opposeLegendCount: stanceCounts.oppose,
  };
  for (const [id, value] of Object.entries(legendCounts)) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.append(el('p', { className: 'panel-kicker', textContent: '航线分布' }));
  const top = el('div', { className: 'summary-top' });
  top.append(el('span', { className: 'summary-count', textContent: `${summary.total}` }));
  top.append(el('span', { className: 'summary-unit', textContent: '条可回看的知乎讨论' }));
  wrap.append(top);
  wrap.append(el('p', { className: 'summary-stance', textContent: `立场重心：${summary.centerLabel || '整体中立'}` }));
  if (state.riskSignals.length) {
    wrap.append(el('p', {
      className: `summary-risk risk-${state.riskLevel}`,
      textContent: `风险护栏：${state.riskSignals.slice(0, 2).map((signal) => signal.detail).join('；')}`,
    }));
  }

  wrap.append(el('p', { className: 'summary-dim-label', textContent: '立场' }));
  wrap.append(dimensionBars('stance', STANCE_ORDER, STANCE_META, stanceCounts, summary.total));
  wrap.append(el('p', { className: 'summary-dim-label', textContent: '论证性质' }));
  wrap.append(dimensionBars('argument', ARGUMENT_ORDER, ARGUMENT_META, argumentCounts, summary.total));
}

function dimensionBars(type, keys, meta, counts, total) {
  const bars = el('div', { className: 'bars' });
  for (const k of keys) {
    const pct = total ? (counts[k] / total) * 100 : 0;
    const active = state.activeFilter?.type === type && state.activeFilter?.key === k;
    const row = el('button', { className: 'bar-row' + (active ? ' active' : ''), onclick: () => toggleFilter(type, k) }, [
      el('span', { className: 'bar-dot', style: `background:${meta[k].color}` }),
      el('span', { className: 'bar-label', textContent: meta[k].label }),
      el('div', { className: 'bar-track' }, [
        el('div', { className: 'bar-fill', style: `width:${pct}%;background:${meta[k].color}` }),
      ]),
      el('span', { className: 'bar-num', textContent: counts[k] }),
    ]);
    bars.append(row);
  }
  return bars;
}

function toggleFilter(type, key) {
  const current = state.activeFilter;
  state.activeFilter = current?.type === type && current?.key === key ? null : { type, key };
  state.activeCluster = null;
  state.sourcesExpanded = false;
  renderSummary(state.summary);
  renderSourceList(state.items);
}

function matchesActiveFilter(it) {
  const filter = state.activeFilter;
  if (!filter) return true;
  if (filter.type === 'stance') return stanceBucket(it) === filter.key;
  return argumentBucket(it) === filter.key;
}

function activeFilterLabel() {
  const filter = state.activeFilter;
  if (!filter) return '';
  if (filter.type === 'stance') return STANCE_META[filter.key].label;
  return ARGUMENT_META[filter.key].label;
}

// ---------- 知乎答案卡列表 ----------
function renderSourceList(items) {
  const wrap = $('#sources');
  wrap.innerHTML = '';
  const allInRoute = items.filter(matchesActiveFilter);
  const primaryInRoute = state.primarySources.filter(matchesActiveFilter);
  const list = state.sourcesExpanded ? allInRoute : primaryInRoute;
  wrap.append(el('p', { className: 'panel-kicker', textContent: '来源航线 · 点击浮标对应的回答' }));
  wrap.append(el('h3', { textContent: state.activeFilter ? `${activeFilterLabel()} · 来源航线` : '先读这 4 条代表性来源' }));
  wrap.append(el('p', { className: 'source-list-intro', textContent: '先打开一条推荐原文，再回来记录第二次判断；其他回答保留在展开区。' }));
  const focusedItem = items.find((item) => sourceKey(item.id) === state.focusedSourceId);
  wrap.append(el('p', {
    id: 'sourceFocusStatus',
    className: 'source-focus-status',
    role: 'status',
    ariaLive: 'polite',
    textContent: sourceFocusStatusText(focusedItem?.title),
  }));
  if (!list.length) {
    wrap.append(el('p', { className: 'muted', textContent: '该航线暂无内容。' }));
    return;
  }
  for (const it of list) {
    const meta = CLUSTER_META[it.cluster];
    const authorInitial = it.author ? it.author.slice(0, 1) : '知';
    const card = el('div', {
      className: 'source-card',
      id: `card-${it.id}`,
      dataset: { id: it.id },
      style: `--cluster-color:${meta.color}`,
    }, [
      el('div', { className: 'sc-avatar', textContent: authorInitial }),
      el('div', { className: 'sc-body' }, [
        el('div', { className: 'sc-title-row' }, [
          el('h4', { className: 'sc-title', textContent: it.title }),
          el('span', { className: 'sc-cluster', style: `color:${meta.color};border-color:${meta.color}`, textContent: meta.label }),
          it.conditionalSide === 'mixed' ? el('span', { className: 'sc-qualifier', textContent: '双向条件' }) : null,
        ]),
        el('p', { className: 'sc-excerpt', textContent: it.excerpt }),
        el('div', { className: 'sc-meta' }, [
          el('span', { className: 'sc-badge', textContent: `L${it.authorityLevel} · ${it.author}` }),
          el('span', { textContent: `赞同 ${it.voteupCount.toLocaleString()}` }),
          el('span', { textContent: `评论 ${it.commentCount.toLocaleString()}` }),
          el('span', { className: 'muted', textContent: it.publishTime }),
          state.isDemo ? el('span', { className: 'demo-tag-inline', textContent: '演示数据' }) : null,
          state.openedSourceIds.has(sourceKey(it.id)) ? el('span', { className: 'read-tag-inline', textContent: '已尝试打开' }) : null,
        ]),
        el('p', {
          className: 'sc-analysis',
          textContent: `判定拆解：立场 ${STANCE_LABEL[it.stance] || '不确定'} · 条件 ${CONDITIONALITY_LABEL[it.conditionality] || '不明确'} · 证据 ${EVIDENCE_LABEL[it.evidenceType] || '不明确'}${it.classificationMethod === 'llm' ? ' · AI 辅助' : ' · 规则初判'}${it.needsHumanReview ? ' · 需复核' : ''}`,
        }),
        it.condition ? el('p', { className: 'sc-condition', textContent: `成立条件：${it.condition}` }) : null,
        it.selectionReason && !state.sourcesExpanded
          ? el('p', { className: 'sc-selection-reason', textContent: `推荐理由：${it.selectionReason}` })
          : null,
        el('div', { className: 'sc-actions' }, [
          sanitizeSourceUrl(it.url)
            ? el('a', { href: sanitizeSourceUrl(it.url), target: '_blank', rel: 'noopener noreferrer', className: 'sc-link', textContent: '打开知乎原文 ↗', onclick: () => recordSourceOpenAttempt(it.id) })
            : el('span', { className: 'muted sc-nolink', textContent: '无原文链接' }),
          el('button', {
            type: 'button',
            ...sourceFocusButtonProps(state.focusedSourceId === sourceKey(it.id)),
            onclick: (event) => focusItem(it.id, event.currentTarget),
          }),
        ]),
      ]),
    ]);
    wrap.append(card);
  }
  const hiddenCount = allInRoute.length - primaryInRoute.length;
  if (hiddenCount > 0) {
    wrap.append(el('button', {
      type: 'button',
      className: 'source-expand-btn',
      textContent: state.sourcesExpanded ? '收起其他来源' : `展开其他 ${hiddenCount} 条来源`,
      onclick: () => { state.sourcesExpanded = !state.sourcesExpanded; renderSourceList(items); },
    }));
  }
}

function renderSourceTeaser() {
  const wrap = $('#sourceTeaserList');
  if (!wrap) return;
  wrap.innerHTML = '';
  const list = state.primarySources.slice(0, 3);
  if (!list.length) {
    wrap.append(el('p', { className: 'muted', textContent: '暂无可回看的知乎来源。' }));
    return;
  }
  for (const item of list) {
    const meta = CLUSTER_META[item.cluster];
    wrap.append(el('article', { className: 'source-teaser-card' }, [
      el('button', {
        type: 'button',
        className: 'source-teaser-title',
        textContent: item.title,
        onclick: () => viewSource(item.id),
      }),
      el('p', { className: 'source-teaser-excerpt', textContent: item.excerpt }),
      el('div', { className: 'source-teaser-meta' }, [
        el('span', { textContent: item.author || '知乎用户' }),
        el('span', { textContent: item.publishTime || '近期' }),
        meta ? el('span', { className: 'source-teaser-cluster', style: `color:${meta.color};border-color:${meta.color}`, textContent: meta.label }) : null,
      ]),
      el('button', {
        type: 'button',
        className: 'source-teaser-link',
        textContent: '查看原文 ↗',
        onclick: () => viewSource(item.id),
      }),
    ]));
  }
}

function recordSourceOpenAttempt(id) {
  const key = sourceKey(id);
  if (!key) return;
  state.openedSourceIds.add(key);
  // 不要在原文链接的 click 事件里重绘来源列表：同步替换 DOM 会让浏览器丢失
  // 当前 anchor 的默认导航动作，造成“文字看起来能点但实际打不开”。只更新已渲染
  // 卡片的打开尝试标记，保留 anchor 的原生 target=_blank 导航。
  const card = document.getElementById(`card-${key}`);
  const meta = card?.querySelector('.sc-meta');
  if (meta && !meta.querySelector('.read-tag-inline')) {
    meta.append(el('span', { className: 'read-tag-inline', textContent: '已尝试打开' }));
  }
  persistResearchState();
  renderGrowthCard();
}

function followSourceRoute(id) {
  if (!document.getElementById(`card-${id}`)) {
    state.activeCluster = null;
    state.activeFilter = null;
    state.sourcesExpanded = true;
    renderSummary(state.summary);
    renderSourceList(state.items);
  }
  showView('sources');
  focusItem(id);
}

function focusItem(id, trigger = null) {
  const key = sourceKey(id);
  const card = document.getElementById(`card-${key}`);
  if (!card) return;
  state.focusedSourceId = key;
  document.querySelectorAll('.source-card').forEach((candidate) => {
    const focused = candidate === card;
    candidate.classList.toggle('focus', focused);
    const button = candidate.querySelector('.sc-reply');
    if (button) {
      const props = sourceFocusButtonProps(focused);
      button.className = props.className;
      button.textContent = props.textContent;
      button.setAttribute('aria-pressed', props.ariaPressed);
    }
  });
  const title = card.querySelector('.sc-title')?.textContent?.trim() || '';
  const status = document.getElementById('sourceFocusStatus');
  if (status) status.textContent = sourceFocusStatusText(title);
  (trigger || card.querySelector('.sc-reply'))?.blur();
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 点击海图浮标只表示查看来源卡，不伪装成已经打开知乎原文。
function viewSource(id) {
  // 海图是全量视图；如果用户此前在某条航线筛选状态下点了另一条浮标，
  // 先解除筛选并重绘来源列表，否则目标卡仍不可见，
  // 形成“看起来能点但没有跳转结果”的断裂交互。
  if (!document.getElementById(`card-${id}`)) {
    state.activeCluster = null;
    state.activeFilter = null;
    state.sourcesExpanded = true;
    renderSummary(state.summary);
    renderSourceList(state.items);
  }
  showView('sources');
  focusItem(id);
}

function renderLearningCard(wrap) {
  const card = state.learningCard || buildLearningCard(state.items, { userStance: state.userStance });
  if (!card.ok || !card.source) return;
  const sourceButton = el('button', { type: 'button', className: 'ch-source learning-card-source', textContent: `定位来源卡 · ${card.source.author}`, onclick: () => followSourceRoute(card.source.id) });
  // 成长卡先记录“尝试打开”状态，再在同一个用户手势中打开原文；这不是阅读完成证明。
  // 让二次判断页看到的来源计数与卡片标记不同步。使用元素 onclick 属性与
  // 页面其他动态按钮保持同一事件绑定路径，兼容真实浏览器的新标签打开行为。
  const sourceLink = el('button', {
    type: 'button',
    className: 'learning-card-url',
    textContent: '打开知乎原文 ↗',
    dataset: { sourceId: sourceKey(card.source.id), sourceUrl: card.source.url },
  });
  const learning = el('section', { className: 'learning-card', ariaLabel: '来源挑战' }, [
    el('p', { className: 'panel-kicker', textContent: '来源挑战 · 先读这一条' }),
    el('h4', { textContent: '这条回答补充了一个值得核对的理由' }),
    el('div', { className: 'learning-card-actions' }, [sourceButton, sourceLink]),
    el('p', { className: 'learning-card-summary', textContent: card.keyDisagreement }),
    el('dl', { className: 'learning-card-facts' }, [
      el('div', {}, [el('dt', { textContent: '成立条件' }), el('dd', { textContent: card.condition })]),
      el('div', {}, [el('dt', { textContent: '证据类型' }), el('dd', { textContent: card.evidenceTypeLabel })]),
      el('div', {}, [el('dt', { textContent: '来源写出的条件' }), el('dd', { textContent: card.overlookedPremise })]),
    ]),
    el('blockquote', { className: 'learning-card-excerpt', textContent: `“${card.source.excerpt}”` }),
    el('p', { className: 'muted', textContent: `来源：${card.source.author} · ${card.method === 'llm' ? 'AI 辅助提取' : '规则初判'} · ${card.needsHumanReview ? '未人工复核' : '已绑定原始来源'}` }),
  ]);
  wrap.append(learning);
}

// ---------- 观点成长卡（确定性 source-gated 挑战） ----------
function renderGrowthCard() {
  const wrap = $('#growth');
  wrap.innerHTML = '';
  wrap.append(el('p', { className: 'panel-kicker', textContent: '来源挑战' }));
  wrap.append(el('h3', { textContent: '这条回答，正在挑战你的初始判断' }));
  if (!state.userStance) {
    wrap.append(el('p', { className: 'muted', textContent: '先选择你的立场，生成专属成长卡 →' }));
    return;
  }
  const stanceLabel = { support: '支持', oppose: '反对', neutral: '中立' }[state.userStance];
  wrap.append(el('p', { className: 'growth-stance', textContent: `你的立场：${stanceLabel}` }));
  const learningFacts = state.learningCard || {};
  wrap.append(el('div', { className: 'challenge-facts' }, [
    el('div', { className: 'challenge-fact' }, [el('b', { textContent: '关键分歧' }), el('span', { textContent: learningFacts.keyDisagreement || '需要回到具体场景核对' })]),
    el('div', { className: 'challenge-fact' }, [el('b', { textContent: '成立条件' }), el('span', { textContent: learningFacts.condition || '成立范围取决于具体边界' })]),
    el('div', { className: 'challenge-fact' }, [el('b', { textContent: '证据类型' }), el('span', { textContent: learningFacts.evidenceTypeLabel || '行业经验与原文依据' })]),
  ]));

  const clusters = groupByCluster(state.items);
  const challenges = generateChallenges({
    userStance: stanceLabel,
    clusters,
    summary: { total: state.summary.total },
  });
  if (challenges[0]?.text) wrap.append(el('p', { className: 'challenge-lead', textContent: challenges[0].text }));
  renderLearningCard(wrap);

  if (state.disagreement && state.disagreement.refs.length) {
    const disagreement = el('details', { className: 'disagreement-details' }, [
      el('summary', { textContent: '展开关键分歧依据' }),
      el('p', { className: 'muted', textContent: `${state.disagreement.method === 'llm' ? 'AI 辅助提取' : '来源规则初判'} · 未人工复核` }),
    ]);
    if (state.disagreement.refs.length) {
      const refs = el('div', { className: 'disagreement-refs' });
      for (const ref of state.disagreement.refs) refs.append(el('button', { type: 'button', className: 'ch-source', textContent: `查看依据 · ${ref.author}`, onclick: () => followSourceRoute(ref.id) }));
      disagreement.append(refs);
    }
    wrap.append(disagreement);
  }

  if (!challenges.length) {
    wrap.append(el('p', { className: 'muted', textContent: '当前光谱未触发明确挑战，你的立场与讨论结构基本一致。' }));
  }
  const visibleChallenges = challenges.slice(0, 1);
  for (const ch of visibleChallenges) {
    const card = el('div', { className: 'challenge-card' }, [
      el('span', { className: 'ch-type', style: `background:${CHALLENGE_COLOR[ch.type]}`, textContent: CHALLENGE_TYPES[ch.type] }),
      ch.sourceRef
        ? el('button', { type: 'button', className: 'ch-source', textContent: `查看来源卡 · ${ch.sourceRef.author}`, onclick: () => followSourceRoute(ch.sourceRef.id) })
        : null,
    ]);
    wrap.append(card);
  }
  if (challenges.length > visibleChallenges.length) {
    const moreChallenges = el('details', { className: 'more-challenges' }, [
      el('summary', { textContent: `查看其他 ${challenges.length - visibleChallenges.length} 个挑战` }),
    ]);
    for (const ch of challenges.slice(1)) {
      moreChallenges.append(el('div', { className: 'challenge-card challenge-card-secondary' }, [
        el('span', { className: 'ch-type', style: `background:${CHALLENGE_COLOR[ch.type]}`, textContent: CHALLENGE_TYPES[ch.type] }),
        el('p', { className: 'ch-text', textContent: ch.text }),
        ch.sourceRef ? el('button', { type: 'button', className: 'ch-source', textContent: `查看来源 · ${ch.sourceRef.author}`, onclick: () => followSourceRoute(ch.sourceRef.id) }) : null,
      ]));
    }
    wrap.append(moreChallenges);
  }

  for (const recommendation of state.riskRecommendations.slice(0, 2)) {
    wrap.append(el('div', { className: 'challenge-card risk-card' }, [
      el('span', { className: 'ch-type', textContent: '风险护栏' }),
      el('p', { className: 'ch-text', textContent: recommendation.text }),
      recommendation.sourceRef
        ? el('button', { type: 'button', className: 'ch-source', textContent: `查看来源卡 · ${recommendation.sourceRef.author}`, onclick: () => followSourceRoute(recommendation.sourceRef.id) })
        : null,
    ]));
  }

  const recs = selectReadingRecommendations(state.items, state.userStance);
  wrap.append(el('p', {
    className: 'growth-rec',
    textContent: recs.length
      ? readingRecommendationLabel(state.userStance) + recs.map((r) => `${r.title}（${r.author}）`).join('；')
      : `${readingRecommendationLabel(state.userStance)}当前没有可核验的来源。`,
  }));
  wrap.append(el('p', { className: 'growth-next', textContent: '下一步讨论问题：' + nextQuestion(state.userStance) }));
  wrap.append(el('button', {
    type: 'button',
    className: 'secondary-action growth-sources-link',
    textContent: '查看其他来源 ›',
    onclick: () => showView('sources'),
  }));

  updateStageBar();
}

function renderSecondJudgmentScreen() {
  const mount = $('#secondJudgmentMount');
  if (!mount) return;
  mount.innerHTML = '';
  syncRecheckBackLink();
  if (!state.userStance) return;
  const stanceLabel = { support: '支持', oppose: '反对', neutral: '中立' }[state.userStance];
  renderSecondJudgment(mount, stanceLabel);
}

function syncRecheckBackLink() {
  const button = $('#recheckBack');
  if (!button) return;
  const submitted = Boolean(state.secondJudgment);
  button.dataset.backView = submitted ? 'complete' : 'reading';
  button.textContent = submitted ? '‹ 返回完成结果' : '‹ 返回阅读来源';
}

function renderCompletionView() {
  const summary = $('#completionSummary');
  const actions = $('#completionActions');
  if (!summary || !actions) return;
  summary.innerHTML = '';
  actions.innerHTML = '';
  if (!state.secondJudgment) return;
  const stanceText = { support: '支持', oppose: '反对', neutral: '中立' };
  const before = stanceText[state.userStance] || '未标注';
  const after = stanceText[state.secondJudgment.stance] || '未标注';
  summary.append(
    el('p', { className: 'panel-kicker', textContent: '第三站 · 重新判断' }),
    el('h2', { textContent: '你的判断已经记录' }),
    el('p', { textContent: `Before：${before} · 尝试打开 ${state.openedSourceIds.size} 条来源 · After：${after}` }),
    el('p', { className: 'completion-reason', textContent: state.secondJudgment.reason || '这次没有补充文字理由，但你完成了一次主动复核。' }),
  );
  const shareBtn = el('button', { className: 'share-btn', textContent: '复制 Before / After 分享文案', onclick: () => copyShareText(shareBtn) });
  const shareCardBtn = el('button', { className: 'share-btn ghost', textContent: '生成 Before / After 图卡', onclick: () => generateShareCard(shareCardBtn) });
  actions.append(shareBtn, shareCardBtn);
  $('#compare')?.classList.remove('hidden');
}

function renderSecondJudgment(wrap, stanceLabel) {
  const panel = el('section', { className: 'second-judgment', ariaLabel: '二次判断' });
  panel.append(
    el('p', { className: 'panel-kicker', textContent: '第三站 · 靠岸前' }),
    el('h3', { textContent: '现在，你的判断是？' }),
    el('div', { className: 'judgment-recap-strip' }, [
      el('span', { textContent: `原来：${stanceLabel}` }),
      el('span', { textContent: `已读 ${state.openedSourceIds.size}/${state.items.length} 条` }),
      el('span', { textContent: '现在怎么选？' }),
    ]),
  );

  const submitted = Boolean(state.secondJudgment);
  const choices = stanceChoiceButtons({
    selected: state.secondDraftStance,
    disabled: submitted,
    ariaLabel: '选择二次立场',
    onSelect: (value) => { state.secondDraftStance = value; renderSecondJudgmentScreen(); },
  });
  const reasonId = 'secondReason';
  const reason = el('textarea', {
    id: reasonId,
    rows: 3,
    disabled: submitted,
    placeholder: '可选：读完来源后，我的理由变得……',
    value: state.secondJudgment?.reason || state.secondDraftReason,
    oninput: (event) => { state.secondDraftReason = event.target.value; },
  });
  const feedback = submitted ? buildAfterFeedback() : state.secondFeedbackMessage;
  panel.append(
    choices,
    el('label', { className: 'reason-label', htmlFor: reasonId, textContent: '二次理由（可选）' }),
    reason,
    el('button', {
      type: 'button',
      className: 'primary second-submit',
      disabled: submitted || !state.secondDraftStance,
      textContent: submitted ? '判断已记录' : '记录第二次判断',
      onclick: submitSecondJudgment,
    }),
    el('p', {
      className: 'second-feedback' + (feedback ? ' visible' : ''),
      role: 'status', ariaLive: 'polite',
      textContent: feedback || (state.secondDraftStance ? '' : '请选择二次立场后提交。'),
    }),
  );
  wrap.append(panel);
}

function buildAfterFeedback() {
  const stanceText = { support: '支持', oppose: '反对', neutral: '中立' };
  const readItems = state.items.filter((item) => state.openedSourceIds.has(sourceKey(item.id)));
  const sourceTitles = readItems.slice(0, 2).map((item) => item.title || item.author).join('、') || '未记录具体来源';
  const conditions = [...new Set(readItems.map((item) => item.condition).filter(Boolean))].slice(0, 2);
  const reason = state.secondJudgment.reason || '未补充文字理由';
  const change = state.secondJudgment.stance === state.userStance
    ? `立场未变（${stanceText[state.userStance]}）`
    : `立场从「${stanceText[state.userStance]}」变为「${stanceText[state.secondJudgment.stance]}」`;
  return `Before：${stanceText[state.userStance]}；打开来源：${sourceTitles}；新条件：${conditions.join('；') || '本次未抽取到新的明确条件'}；After：${change}；理由变化：${reason}`;
}

function submitSecondJudgment() {
  if (state.secondJudgment) return;
  if (!state.secondDraftStance) {
    state.secondFeedbackMessage = '请选择二次立场后提交。';
    renderSecondJudgmentScreen();
    return;
  }
  const hasReadableSource = state.items.some((item) => sanitizeSourceUrl(item.url));
  if (hasReadableSource && state.openedSourceIds.size === 0) {
    state.secondFeedbackMessage = '建议先打开至少一条知乎原文，再记录二次判断。';
    renderSecondJudgmentScreen();
    return;
  }
  state.secondJudgment = { stance: state.secondDraftStance, reason: state.secondDraftReason.trim() };
  state.secondFeedbackMessage = '';
  persistResearchState();
  renderSecondJudgmentScreen();
  renderCompletionView();
  showView('complete');
}

// 生成可分享的 Before / After 文本（原观点 → 来源挑战 → 二次判断）
function buildShareText() {
  const stanceLabel = { support: '支持', oppose: '反对', neutral: '中立' }[state.userStance];
  const clusters = groupByCluster(state.items);
  const challenges = generateChallenges({ userStance: stanceLabel, clusters, summary: { total: state.summary.total } });
  const lines = [`【知辩 · 立场校准】话题：${state.query}`, `我原本的立场：${stanceLabel}`];
  if (challenges.length) {
    lines.push('被真实来源挑战的前提：');
    for (const ch of challenges.slice(0, 2)) {
      const srcItem = ch.sourceRef ? state.items.find((i) => i.id === ch.sourceRef.id) : null;
      const url = srcItem ? sanitizeSourceUrl(srcItem.url) : '';
      lines.push(`· ${ch.text}${ch.sourceRef ? `（来源：${ch.sourceRef.author}${url ? ` · ${url}` : ''}）` : ''}`);
    }
  }
  const recs = selectReadingRecommendations(state.items, state.userStance);
  if (recs.length) lines.push(readingRecommendationLabel(state.userStance) + recs.map((r) => r.title).join('；'));
  lines.push('—— 你的观点，经得起反驳吗？');
  return lines.join('\n');
}

// 复制分享文案（clipboard API + execCommand 降级）
async function copyShareText(btn) {
  const text = buildShareText();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = ok ? '已复制 ✓' : '复制失败，请手动选择';
  if (!ok) {
    let fallback = document.getElementById('shareCopyFallback');
    if (!fallback) {
      fallback = el('textarea', {
        id: 'shareCopyFallback',
        className: 'share-copy-fallback',
        rows: 8,
        readOnly: true,
        ariaLabel: '可手动复制的分享文案',
      });
      btn.after(fallback);
    }
    fallback.value = text;
    fallback.focus();
    fallback.select();
  }
  setTimeout(() => { btn.textContent = old; }, 1600);
}

// ---------- B3 可分享坐标图卡（纯前端 Canvas，无第三方库） ----------
// 绘制：观点光谱缩略（四簇节点位置）+ 立场标记 + 话题 + 成长卡要点 + 数据来源徽标。
function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const ch of String(text)) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = ch; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

const SHARE_COLORS = {
  bg: '#F7F8F9', panel: '#FFFFFF', ink: '#171A1D', muted: '#6B7280',
  blue: '#1666D9', amber: '#D6681E', line: '#D9DEE3',
  // 分享图卡复用海图的单一簇颜色源，避免 Canvas 与 SVG 语义漂移。
  cluster: Object.fromEntries(Object.entries(CLUSTER_META).map(([key, meta]) => [key, meta.color])),
};

async function renderShareCard({ query, stanceLabel, challenges, layout, isDemo }) {
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = SHARE_COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // 品牌头
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = SHARE_COLORS.ink; ctx.font = `700 44px ${FONT}`; ctx.textAlign = 'left';
  ctx.fillText('知辩', 60, 96);
  ctx.fillStyle = SHARE_COLORS.blue; ctx.fillText('· 立场校准台', 168, 96);
  ctx.fillStyle = SHARE_COLORS.muted; ctx.font = `400 22px ${FONT}`;
  ctx.fillText('Zhibian · Stance Calibration', 60, 132);

  // 话题
  ctx.fillStyle = SHARE_COLORS.muted; ctx.font = `400 24px ${FONT}`;
  ctx.fillText('话题', 60, 196);
  ctx.fillStyle = SHARE_COLORS.ink; ctx.font = `600 38px ${FONT}`;
  const topicLines = wrapCanvasText(ctx, query || '', W - 120);
  topicLines.slice(0, 2).forEach((ln, i) => ctx.fillText(ln, 60, 244 + i * 50));

  // 光谱缩略面板
  const px0 = 60, py0 = 360, pw = W - 120, ph = 360;
  ctx.fillStyle = SHARE_COLORS.panel;
  roundRect(ctx, px0, py0, pw, ph, 16); ctx.fill();
  ctx.strokeStyle = SHARE_COLORS.line; ctx.lineWidth = 1; ctx.stroke();
  const left = px0 + 70, right = px0 + pw - 40, top = py0 + 60, bottom = py0 + ph - 70;
  const xMap = (x) => left + ((x + 1) / 2) * (right - left);
  const yMap = (y) => bottom - y * (bottom - top);
  // 中轴（立场 0）
  ctx.strokeStyle = SHARE_COLORS.line; ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(xMap(0), top); ctx.lineTo(xMap(0), bottom); ctx.stroke();
  ctx.setLineDash([]);
  // 基线（可信度 0）
  ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(right, bottom); ctx.stroke();
  // 轴标签
  ctx.fillStyle = SHARE_COLORS.muted; ctx.font = `400 20px ${FONT}`;
  ctx.textAlign = 'right'; ctx.fillText('反对', left - 14, bottom + 6);
  ctx.textAlign = 'left'; ctx.fillText('支持', right + 14, bottom + 6);
  ctx.textAlign = 'center'; ctx.fillText('可信度 →', (left + right) / 2, top - 22);
  // 节点
  for (const node of layout) {
    const cx = xMap(Math.max(-1, Math.min(1, node.x)));
    const cy = yMap(Math.max(0, Math.min(1, node.y)));
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(5, node.size * 0.8), 0, Math.PI * 2);
    ctx.fillStyle = node.color || SHARE_COLORS.cluster[node.cluster] || SHARE_COLORS.muted;
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // 用户立场标记（琥珀橙高亮）
  const stanceX = { 支持: 0.8, 反对: -0.8, 中立: 0 }[stanceLabel] ?? 0;
  const sx = xMap(stanceX);
  ctx.beginPath(); ctx.arc(sx, bottom, 16, 0, Math.PI * 2);
  ctx.fillStyle = SHARE_COLORS.amber; ctx.fill();
  ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = SHARE_COLORS.amber; ctx.font = `700 22px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillText('你的立场', sx, bottom - 26);

  // 立场结论行 + 立场徽章（US-28：坐标图卡上的立场徽章，颜色随立场簇）
  ctx.fillStyle = SHARE_COLORS.ink; ctx.font = `600 30px ${FONT}`; ctx.textAlign = 'left';
  ctx.fillText(`你的立场：`, 60, 800);
  const stanceBadge = {
    支持: { label: '支持方', color: CLUSTER_META.support.color },
    反对: { label: '反对方', color: CLUSTER_META.oppose.color },
    中立: { label: '中立', color: SHARE_COLORS.muted },
    // 「未标注」表示用户还没表态，不等于「证据不足」，不借用它簇的颜色
    未标注: { label: '未标注', color: SHARE_COLORS.muted },
  }[stanceLabel || '未标注'] || { label: '未标注', color: SHARE_COLORS.muted };
  const badgeX = 60 + ctx.measureText('你的立场：').width + 16;
  ctx.fillStyle = stanceBadge.color; roundRect(ctx, badgeX, 772, 168, 34, 17); ctx.fill();
  ctx.fillStyle = '#FFFFFF'; ctx.font = `600 22px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillText(stanceBadge.label, badgeX + 84, 796);

  // 成长卡要点
  ctx.fillStyle = SHARE_COLORS.muted; ctx.font = `400 24px ${FONT}`; ctx.textAlign = 'left';
  ctx.fillText('来源挑战 · 值得检查的前提', 60, 856);
  const footerTop = H - 150;
  const challengeBottom = footerTop - 30;
  let yy = 900;
  const shown = (challenges || []).slice(0, 3);
  if (!shown.length) {
    ctx.fillStyle = SHARE_COLORS.muted; ctx.font = `400 24px ${FONT}`;
    ctx.fillText('当前光谱未触发明确挑战，你的立场与讨论结构基本一致。', 60, yy);
  }
  for (let index = 0; index < shown.length; index += 1) {
    const ch = shown[index];
    const color = CHALLENGE_COLOR[ch.type] || SHARE_COLORS.muted;
    const label = CHALLENGE_TYPES[ch.type] || '';
    // 类型色块
    ctx.fillStyle = color; roundRect(ctx, 60, yy - 22, 8, 24, 4); ctx.fill();
    ctx.fillStyle = color; ctx.font = `600 22px ${FONT}`;
    ctx.fillText(label, 80, yy - 2);
    ctx.fillStyle = SHARE_COLORS.ink; ctx.font = `400 24px ${FONT}`;
    const textLines = wrapCanvasText(ctx, ch.text, W - 200);
    // 底栏固定在 footerTop 之后；按剩余高度裁切长文案，避免最后一条覆盖底栏。
    const maxLines = Math.min(2, textLines.length || 1, Math.max(1, Math.floor((challengeBottom - yy - 22) / 30)));
    const visibleLines = textLines.slice(0, maxLines);
    if (textLines.length > maxLines && visibleLines.length) visibleLines[visibleLines.length - 1] = `${visibleLines[visibleLines.length - 1]}…`;
    visibleLines.forEach((ln, i) => ctx.fillText(ln, 80, yy + 30 + i * 30));
    yy += 22 + maxLines * 30 + 18;
  }

  // 底栏：数据来源徽标 + tagline
  ctx.fillStyle = isDemo ? '#FFF7E6' : '#E7F0E9';
  ctx.strokeStyle = isDemo ? '#E8C889' : '#16806B';
  roundRect(ctx, 60, H - 150, 250, 48, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = isDemo ? '#8A6D1A' : '#16806B'; ctx.font = `600 24px ${FONT}`; ctx.textAlign = 'center';
  ctx.fillText(isDemo ? '演示数据' : '知乎公开来源', 185, H - 118);
  ctx.fillStyle = SHARE_COLORS.ink; ctx.font = `600 30px ${FONT}`; ctx.textAlign = 'right';
  ctx.fillText('你的观点，经得起反驳吗？', W - 60, H - 118);

  const download = () => new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) { resolve(false); return; }
      const a = document.createElement('a');
      const safe = String(query || '立场校准').replace(/[^\w一-龥-]/g, '_').slice(0, 30);
      a.href = URL.createObjectURL(blob);
      a.download = `知辩-立场校准-${safe}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      resolve(true);
    }, 'image/png');
  });
  const copyToClipboard = async () => {
    try {
      if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') return false;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) return false;
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch (e) {
      return false;
    }
  };
  return { canvas, download, copyToClipboard };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function generateShareCard(btn) {
  if (btn?.disabled) return;
  const oldButtonText = btn?.textContent || '';
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = '正在生成…'; }
  try {
    const stanceLabel = { support: '支持', oppose: '反对', neutral: '中立' }[state.userStance];
    const clusters = groupByCluster(state.items);
    const challenges = generateChallenges({ userStance: stanceLabel, clusters, summary: { total: state.summary.total } });
    const { canvas, download, copyToClipboard } = await renderShareCard({
      query: state.query, stanceLabel, challenges, layout: state.layout, isDemo: state.isDemo,
    });
    const box = $('#shareCardBox');
    box.classList.remove('hidden');
    box.innerHTML = '';
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    canvas.style.borderRadius = '10px';
    box.append(canvas);
    const dl = el('button', { type: 'button', className: 'share-btn', textContent: '下载 PNG', onclick: async () => {
      if (dl.disabled) return;
      dl.disabled = true;
      const old = dl.textContent;
      dl.textContent = '正在准备…';
      const okDownload = await download();
      dl.textContent = okDownload ? '已下载 ✓' : '下载失败，请重试';
      setTimeout(() => { dl.textContent = old; dl.disabled = false; }, 1600);
    } });
    const cp = el('button', { type: 'button', className: 'share-btn ghost', textContent: '复制图片', onclick: async () => {
      if (cp.disabled) return;
      cp.disabled = true;
      const okClip = await copyToClipboard();
      const old = cp.textContent;
      cp.textContent = okClip ? '已复制 ✓' : '复制失败，请下载';
      setTimeout(() => { cp.textContent = old; cp.disabled = false; }, 1600);
    } });
    box.append(el('div', { className: 'share-card-actions' }, [dl, cp]));
  } catch (error) {
    const box = $('#shareCardBox');
    box.classList.remove('hidden');
    box.innerHTML = '';
    box.append(el('p', { className: 'muted', textContent: '图片生成失败，请稍后重试。' }));
  } finally {
    if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = oldButtonText; }
  }
}

function groupByCluster(items) {
  const g = { support: { items: [] }, oppose: { items: [] }, conditional: { items: [] }, insufficient: { items: [] } };
  for (const it of items) g[it.cluster].items.push(it);
  return g;
}

function nextQuestion(stance) {
  if (stance === 'support') return '如果前提条件不满足，你的主张还成立吗？';
  if (stance === 'oppose') return '是否存在支持方证据被你低估的情况？';
  return '你想先验证哪一方的论据，再决定立场？';
}

// ---------- 直答对照片（稀缺配额，独立面板） ----------
// 直答场景文案覆盖：仅在直答语境有专属文案时覆盖，其余走统一公共出口（errors.js）
const DA_REASON = {
  quota_exhausted: '今日知乎直答额度已用完（100/日）。建议明日再试，或先看左侧光谱。',
  no_result: '该话题暂无直答结果。',
};

async function loadDirectAnswer() {
  if (!state.query) return;
  const button = $('#daBtn');
  if (button?.disabled) return;
  const oldButtonText = button?.textContent || '';
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = '正在生成知乎直答…'; }
  const query = state.query;
  const runId = state.searchRunId;
  const directRun = runController.beginDirectAnswer();
  const isCurrent = () => runId === state.searchRunId && query === state.query && !directRun.signal.aborted;
  const r = $('#daResult');
  r.innerHTML = '<p class="muted">正在调用知乎直答 Agent…</p>';
  // US-25 流式直答：开关开启时走 stream 模式（SSE 逐块渲染；mock 走打字机模拟），失败自动回退非流式
  let res;
  if (window._daStreamEnabled && window._daStreamEnabled()) {
    let streamedMarkdown = '';
    try {
      res = await adapter.directAnswer(query, {
        stream: true,
        signal: directRun.signal,
        onChunk: (chunk) => {
          if (!isCurrent()) return;
          let answer = r.querySelector('.da-answer');
          if (!answer) { r.innerHTML = ''; answer = el('div', { className: 'da-answer' }); r.append(answer); }
          streamedMarkdown += chunk;
          renderMarkdown(answer, streamedMarkdown);
        },
      });
    } catch (e) {
      res = null;
    }
  } else {
    res = await adapter.directAnswer(query, { signal: directRun.signal }).catch(() => null);
  }
  if (!isCurrent()) { releaseDirectAnswerButton(button, oldButtonText); return; }
  if (!res || !res.ok || res.empty) {
    // 仅对可重试的流故障回退一次；额度、未配置和确实无结果不重复请求。
    const nonRetryable = ['quota_exhausted', 'not_configured', 'oauth_session_required', 'no_result'];
    const retryable = !res || ['network_error', 'api_error'].includes(res.reason) || (res.empty && !nonRetryable.includes(res.reason));
    if (retryable && isCurrent()) res = await adapter.directAnswer(query, { signal: directRun.signal }).catch(() => null);
    if (!isCurrent()) { releaseDirectAnswerButton(button, oldButtonText); return; }
    r.innerHTML = '';
    if (!res || !res.ok || res.empty) {
      r.append(el('div', { className: 'downgrade' }, [el('p', { textContent: publicMessage(res?.reason, DA_REASON[res?.reason]) })]));
      releaseDirectAnswerButton(button, oldButtonText);
      return;
    }
    const answer = el('div', { className: 'da-answer' });
    renderMarkdown(answer, res.answer);
    r.append(answer);
  }
  // 非流式成功响应不会经过 onChunk；清掉初始 loading 文案，避免“加载中”和答案同时存在。
  if (!r.querySelector('.da-answer')) {
    r.innerHTML = '';
    const answer = el('div', { className: 'da-answer' });
    renderMarkdown(answer, res.answer);
    r.append(answer);
  }
  if (res.citations && res.citations.length) {
    const cw = el('div', { className: 'da-cites' }, [el('span', { className: 'muted', textContent: '知乎直答引用：' })]);
    for (const c of res.citations) {
      cw.append(el('button', { type: 'button', className: 'da-cite', textContent: c.author, onclick: () => followSourceRoute(c.id) }));
    }
    r.append(cw);
  } else {
    // 真实模式直答不返回结构化引用（官方契约如此）：明确披露，不伪造引用
    r.append(el('p', { className: 'muted', textContent: '知乎直答真实模式不返回结构化引用，以上文正文为准。' }));
  }
  releaseDirectAnswerButton(button, oldButtonText);
}

function releaseDirectAnswerButton(button, text) {
  if (!button) return;
  button.disabled = false;
  button.removeAttribute('aria-busy');
  button.textContent = text;
}

// ---------- 降级态（统一出口：文案单一事实源见 src/errors.js） ----------
function renderDowngrade(res) {
  // no_result 场景带示例话题引导，其余回公共文案
  const fallback = res.reason === 'no_result' ? '未检索到相关讨论。换个更具体的问法，或试试下方示例话题。' : null;
  const msg = publicMessage(res.reason, fallback);
  state.items = [];
  state.layout = [];
  state.summary = null;
  state.primarySources = [];
  state.sourceSelection = null;
  state.disagreement = null;
  state.learningCard = null;
  state.isDemo = Boolean(res.demo);
  state.aiClustered = false;
  renderDataBadge(false);
  $('#judgmentLock').classList.add('hidden');
  for (const id of VIEW_IDS) document.getElementById(id)?.classList.add('hidden');
  const wrap = $('#downgradePanel');
  wrap.classList.remove('hidden');
  wrap.innerHTML = `<div class="downgrade"><h3>暂时没有可展开的观点海域</h3><p>${msg}</p>
    <div class="chips">${MOCK_TOPICS.map((t) => `<button class="chip" data-q="${t.query}">${t.query}</button>`).join('')}</div></div>`;
  wrap.querySelectorAll('.chip').forEach((b) =>
    b.addEventListener('click', () => { $('#q').value = b.dataset.q; runSearch(b.dataset.q); })
  );
  setStatus('本次没有发现可回看的知乎讨论 · 可以换一条航线再试');
}

// ---------- 状态条 ----------
function setStatus(txt) {
  $('#status').textContent = txt;
}

// ---------- 知乎热榜入口（真实模式实时、Mock 模式明确标为演示） ----------
// 首屏只铺 HOT_CHIPS_COLLAPSED 条，其余真实条目通过“展开”入口补齐：
// 折叠只是视觉节奏，不丢弃真实数据（避免“有数据但前端看不到”）。
const HOT_CHIPS_COLLAPSED = 6;

function setHotLabel() {
  const label = $('#hotLabel');
  if (label) label.textContent = dataStatus().hot;
}

function hotRow(item, index) {
  return el('li', { className: 'hot-item' }, [
    el('button', {
      type: 'button',
      className: 'hot-link',
      ariaLabel: item.scenario ? `${item.scenario}：${item.title}` : item.title,
      title: item.title,
      onclick: () => { $('#q').value = item.title; runSearch(item.title); },
    }, [
      el('span', { className: 'hot-rank', textContent: String(index + 1).padStart(2, '0') }),
      el('span', { className: 'hot-title', textContent: item.scenario ? `${item.scenario} · ${item.title}` : item.title }),
    ]),
  ]);
}

async function loadHotChips() {
  setHotLabel();
  const box = $('#hotBox');
  const listEl = $('#hotList');
  const toggle = $('#hotToggle');
  if (!box || !listEl) return;
  // 加载可被未来的刷新入口重复调用；先清除旧展开节点的闭包和状态，
  // 避免上一次 >10 条、这一次 <=10 条时仍能插回旧数据。
  if (toggle) {
    toggle.hidden = true;
    toggle.onclick = null;
    toggle.dataset.expanded = 'false';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '展开全部';
  }
  // 服务端限幅 30（官方 hot_list 上限同为 30），一次取满再由前端决定折叠。
  const res = await adapter.hotList({ limit: 30 });
  if (!res.ok || res.empty) {
    listEl.innerHTML = '';
    if (toggle) toggle.hidden = true;
    if (!liveProvider) {
      // 离线演示模式：热榜入口退回上方示例话题，整块隐藏保持首页干净。
      box.classList.add('hidden');
      return;
    }
    // 真实模式：不静默消失，明确披露降级原因，示例话题仍可用。
    // 文案走 errors.js 单出口，用场景化 fallback 覆盖公共文案（口径仍是「不可用」，不伪装成功）。
    listEl.append(el('li', { className: 'hot-item hot-item-degraded' }, [el('span', {
      className: 'muted hot-degraded',
      textContent: publicMessage(res.reason, '知乎热榜暂时不可用，可以先试试上面的示例话题。'),
    })]));
    box.classList.remove('hidden');
    return;
  }
  listEl.innerHTML = '';
  res.items.slice(0, HOT_CHIPS_COLLAPSED).forEach((h, i) => listEl.append(hotRow(h, i)));
  const rest = res.items.slice(HOT_CHIPS_COLLAPSED);
  if (rest.length && toggle) {
    const restNodes = rest.map((h, i) => hotRow(h, i + HOT_CHIPS_COLLAPSED));
    toggle.hidden = false;
    toggle.dataset.expanded = 'false';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = `展开全部 ${res.items.length} 条`;
    toggle.onclick = () => {
      const expanded = toggle.dataset.expanded === 'true';
      if (expanded) {
        restNodes.forEach((node) => node.remove());
        toggle.textContent = `展开全部 ${res.items.length} 条`;
        toggle.dataset.expanded = 'false';
        toggle.setAttribute('aria-expanded', 'false');
        return;
      }
      restNodes.forEach((node) => listEl.append(node));
      toggle.textContent = '收起';
      toggle.dataset.expanded = 'true';
      toggle.setAttribute('aria-expanded', 'true');
    };
  }
  box.classList.remove('hidden');
}

// ---------- 收藏夹校准：游客主链独立；真实模式必须显式授权，绝不伪造个人收藏 ----------
async function openFavorites() {
  const panel = $('#favPanel');
  const chipsEl = $('#favChips');
  if (!panel || !chipsEl) return;
  panel.classList.remove('hidden');
  chipsEl.innerHTML = '<span class="muted">正在读取收藏夹…</span>';
  const res = await adapter.favoritesLists();
  chipsEl.innerHTML = '';
  if (!res.ok || res.empty) {
    if (liveProvider && ['oauth_session_required', 'oauth_session_expired'].includes(res.reason)) {
      setStatus(res.reason === 'oauth_session_expired' ? '知乎授权已失效，正在重新登录…' : '正在跳转知乎授权…');
      window.location.assign('/api/zhihu/oauth/login');
      return;
    }
    if (!liveProvider) {
      chipsEl.append(el('p', { className: 'muted', textContent: '本地演示收藏夹：' }));
      for (const f of MOCK_FAVORITES) {
        chipsEl.append(el('button', { className: 'chip fav-chip', textContent: `${f.title}（演示）`, onclick: () => pickFavorites(f.urlToken, { demo: true }) }));
      }
      return;
    }
    const msg = res.reason === 'oauth_not_configured'
      ? '收藏夹校准正在配置中，请稍后再试。'
      : '暂时无法读取收藏夹，请稍后重试。';
    chipsEl.append(el('p', { className: 'muted', textContent: msg }));
    return;
  }
  for (const f of res.items) {
    chipsEl.append(el('button', { className: 'chip fav-chip', textContent: f.title, onclick: () => pickFavorites(f.urlToken) }));
  }
}

async function pickFavorites(urlToken, { demo = false } = {}) {
  const run = runController.beginSearch();
  const runId = run.id;
  state.searchRunId = runId;
  $('#homeScreen')?.classList.add('hidden');
  $('#results')?.classList.remove('hidden');
  resetRunScopedState();
  resetResultView();
  setStatus('正在读取收藏夹…');
  // 仅本地 mock 允许使用明确标记的演示收藏夹；公网永不以演示个人数据替代 OAuth。
  const demoFavorite = demo
    ? MOCK_FAVORITES.find((favorite) => String(favorite.urlToken) === String(urlToken))
    : null;
  const res = demoFavorite
    ? { ok: true, empty: false, items: demoFavorite.items, title: demoFavorite.title, demo: true }
    : await adapter.favoritesItems(urlToken, { signal: run.signal });
  if (runId !== state.searchRunId) return;
  if (!res.ok || res.empty) {
    // 收藏夹为空时不能停在 resetResultView 后的空白页，给出明确结果和返回入口。
    $('#results')?.classList.remove('hidden');
    for (const id of VIEW_IDS) document.getElementById(id)?.classList.add('hidden');
    const emptyPanel = $('#downgradePanel');
    if (emptyPanel) {
      emptyPanel.classList.remove('hidden');
      emptyPanel.innerHTML = `<div class="downgrade"><h3>这个收藏夹暂时没有可分析内容</h3><p>知乎返回的收藏内容为空，可能是收藏夹未公开或暂时没有条目。你仍可从示例话题开始体验。</p><button type="button" class="primary" id="emptyFavoritesHome">返回首页</button></div>`;
      emptyPanel.querySelector('#emptyFavoritesHome')?.addEventListener('click', showHome);
    }
    setStatus(['oauth_not_configured', 'oauth_session_required', 'oauth_session_expired'].includes(res.reason) ? '收藏夹校准需要重新授权或完成服务端配置。' : '该收藏夹暂无可分析内容。');
    return;
  }
  const fused = fuse(res.items);
  const clustered = cluster(fused);
  resetJudgment();
  resetResultView();
  state.items = clustered;
  state.primarySources = selectRepresentativeSources(clustered);
  state.sourceSelection = sourceSelectionSummary(clustered, state.primarySources);
  state.disagreement = buildKeyDisagreement(clustered);
  state.learningCard = buildLearningCard(clustered, { userStance: null });
  updateRiskState(clustered);
  state.sourcesExpanded = false;
  state.layout = computeLayout(clustered);
  state.summary = computeSummary(clustered);
  state.activeCluster = null;
  state.activeFilter = null;
  state.mode = 'favorites';
  state.query = `我的收藏夹 · ${res.title || '未命名'}`;
  state.isDemo = Boolean(res.demo);
  state.researchRun = createResearchRun({
    runId: `favorites-${runId}`,
    mode: 'favorites',
    topic: state.query,
    isDemo: Boolean(res.demo),
    items: clustered,
  });
  // 真实收藏夹内容不进入通用 7 天本地研究快照；旧的游客快照也不应在此时保留。
  if (!state.isDemo) clearPersistedResearchState();
  const journeyTitle = $('#journeyTitle');
  if (journeyTitle) journeyTitle.textContent = state.query;
  $('#daResult').innerHTML = '';
  prepareJudgmentLock();
  setStatus(`${pageIsDemo() ? '演示数据 · ' : ''}已发现 ${clustered.length} 条可回看的知乎讨论 · 请先锁定判断`);
}

// ---------- 初始化 ----------
function init() {
  applyDataStatusCopy();
  $('#homeLink')?.addEventListener('click', (event) => { event.preventDefault(); showHome(); });
  $('#resultsHomeLink')?.addEventListener('click', showHome);
  $('#searchBtn').addEventListener('click', () => {
    const v = $('#q').value.trim();
    if (v) runSearch(v);
  });
  $('#q').addEventListener('input', syncSearchButton);
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#searchBtn').click(); });
  syncSearchButton();
  document.querySelectorAll('[data-topic]').forEach((card) => {
    card.addEventListener('click', () => {
      const topic = card.dataset.topic?.trim();
      if (!topic) return;
      $('#q').value = topic;
      runSearch(topic);
    });
  });

  // 直答对照片面板（US-25：按开关决定流式 or 一次性返回）
  $('#daBtn').addEventListener('click', loadDirectAnswer);
  window._daStreamEnabled = () => { const t = document.getElementById('daStream'); return !t || t.checked; };

  // 收藏夹校准入口（B1，可插拔：OAuth 未完成时演示收藏夹 + 降级提示）
  $('#favBtn').addEventListener('click', openFavorites);
  $('#sourceTeaserMore')?.addEventListener('click', () => showView('sources'));

  // 成长卡会在结果渲染后动态替换；统一在文档层接管来源按钮，确保
  // “先记账、再开原文”在不同浏览器和新标签行为下都保持一致。
  document.addEventListener('click', (event) => {
    const link = event.target?.closest?.('.learning-card-url');
    if (!link?.dataset?.sourceId) return;
    recordSourceOpenAttempt(link.dataset.sourceId);
    if (link.dataset.sourceUrl) window.open(link.dataset.sourceUrl, '_blank', 'noopener,noreferrer');
  });

  $('#recheckNav')?.addEventListener('click', () => showView('recheck'));
  document.querySelectorAll('[data-back-view]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.backView));
  });

  // 知乎热榜（实时话题入口；游客降级时自动隐藏）
  loadHotChips();
  // 旧 Demo 与主站共用同源 OAuth 会话；启动时探测一次，避免授权后仍显示游客体验。
  void refreshOAuthStatus();
  // 打开根路径必须停留在首页。历史研究状态只保留给未来明确的“继续上次研究”入口，
  // 不能在用户没有任何操作时把首页切成二级结果页。
}

// ---------- 阶段条 ----------
function updateStageBar() {
  const items = document.querySelectorAll('#stageBar .stage-item');
  const arrows = document.querySelectorAll('#stageBar .stage-arrow');
  if (!items.length) return;
  const activeStage = ['recheck', 'complete'].includes(state.view)
    ? 3
    : ['reading', 'sources'].includes(state.view)
      ? 2
      : 1;
  const progressNumber = $('#journeyProgressNumber');
  if (progressNumber) progressNumber.textContent = String(activeStage).padStart(2, '0');
  items.forEach((item) => {
    item.classList.toggle('active', Number(item.dataset.stage) === activeStage);
  });
  arrows.forEach((arrow) => {
    arrow.classList.toggle('active', Number(arrow.dataset.line) < activeStage);
  });
}

document.addEventListener('DOMContentLoaded', init);
