import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const topicCss = fs.readFileSync(new URL('../../assets/reference-topic-cards.css', import.meta.url), 'utf8');

test('首页把输入框表达成观点测试入口，而不是搜索框', () => {
  assert.match(html, /输入一个你已有看法的争议问题/);
  assert.match(html, /placeholder="例如：AI 会不会取代程序员？"/);
  assert.match(html, />先表态 <span aria-hidden="true">→<\/span></);
  assert.match(html, /表态 → 阅读知乎分歧 → 再次判断/);
  assert.doesNotMatch(html, /id="searchBtn"[^>]*>开始观点测试/);
});

test('演示模式口径只保留演示数据，不混用真实数据或演示原版', () => {
  assert.match(html, /演示数据 · 来源结构与真实体验一致/);
  assert.doesNotMatch(html, /演示原版/);
  assert.doesNotMatch(html, /实时数据来自知乎开放平台/);
  assert.doesNotMatch(app, /真实数据'/);
  assert.match(app, /function dataStatus\(\)/);
  assert.match(app, /知乎公开来源/);
});

test('推荐话题卡片给出明确动作，且中间卡不再单独描边', () => {
  assert.equal((html.match(/开始这个观点测试 →/g) || []).length, 3);
  assert.doesNotMatch(topicCss, /topic-card-ai \{\s*border: 2px solid #8bbdff/);
  assert.match(topicCss, /topic-card-action/);
});

test('第一站和第三站共用 stance-card 选中态，未选择时主按钮禁用', () => {
  assert.match(app, /function stanceChoiceButtons\(/);
  assert.match(app, /disabled: !state\.draftStance/);
  assert.match(app, /disabled: submitted \|\| !state\.secondDraftStance/);
  assert.match(css, /stance-card-check/);
});

test('手机端第二站先看统计和挑战，海图后置；立场三项保持一行', () => {
  assert.match(css, /\.summary-panel \{ order: 1; \}/);
  assert.match(css, /\.growth-panel \{ order: 2; \}/);
  assert.match(css, /\.sea-map-panel \{ order: 3; \}/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});
