import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const topicCss = fs.readFileSync(new URL('../../assets/reference-topic-cards.css', import.meta.url), 'utf8');

test('reference UI keeps the supplied brand and page copy', () => {
  assert.match(html, /知<span class="mark">辩<\/span> <span class="brand-latin">Zhibian<\/span>/);
  assert.match(html, /知乎 · 游客体验/);
  assert.match(html, /先表达观点，<br \/>再读知乎，<br \/>最后(?:<i class="hl">)?重新判断(?:<\/i>)?。/);
  assert.match(html, /三条稳定演示路线/);
  assert.match(html, /<span class="journey-kicker">话题<\/span>/);
});

test('reference UI keeps the wide responsive canvas instead of shrinking the page to the design-board width', () => {
  // v1.3：设计稿是首页/结果页并排的两块 ~700px 画板，照搬其绝对宽度会让桌面端左右大片留白。
  assert.doesNotMatch(css, /--reference-width/);
  assert.doesNotMatch(css, /\.controls \{ display: none; \}/);
  assert.match(css, /\.wrap \{ max-width: 12\d\dpx; margin: 0 auto; padding: 0 24px; \}/);
  assert.match(css, /\.reading-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1\.65fr\)\s+minmax\(190px, \.75fr\)/);
});

test('reference details survive at readable scale (brand latin, search icon, favorites entry)', () => {
  assert.match(html, /<span class="brand-latin">Zhibian<\/span>/);
  assert.match(html, /<span class="search-icon" aria-hidden="true">⌕<\/span>/);
  assert.match(html, /id="favBtn" class="fav-btn">查看收藏夹分析演示<\/button>/);
  assert.match(html, /<span class="controls-hint">体验收藏夹观点分析（预览）<\/span>/);
  assert.match(html, /演示功能，本次不读取你的知乎账号数据/);
  assert.match(css, /\.brand-latin \{[\s\S]*?font-size: 12px;/);
  assert.match(css, /\.search-icon \{[\s\S]*?position: absolute;/);
  assert.match(css, /\.fav-btn \{[\s\S]*?border-radius: 999px;/);
  assert.match(css, /\.controls-hint \{[\s\S]*?color: var\(--ink-soft\)/);
});

test('recommendation cards keep copy and HD media in separate layers', () => {
  assert.equal((html.match(/class="topic-card-media"/g) || []).length, 3);
  assert.match(html, /topic-cards\/learning\.webp/);
  assert.match(html, /topic-cards\/ai\.webp/);
  assert.match(html, /topic-cards\/career\.webp/);
  assert.match(topicCss, /\.reference-topic-cards \.topic-card::before,[\s\S]*?display:\s*none\s*!important/);
  assert.match(topicCss, /\.reference-topic-cards \.topic-card-media img\s*\{[\s\S]*?object-fit:\s*cover/);
});
