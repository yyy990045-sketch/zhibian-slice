import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('research journey exposes a visible back path for every forward step', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="resultsHomeLink"[^>]*>‹ 返回首页/);
  assert.match(html, /id="readingView"[\s\S]*data-back-view="judgment"/);
  assert.match(html, /id="sourcesView"[\s\S]*data-back-view="reading"/);
  assert.match(html, /id="recheckView"[\s\S]*id="recheckBack"[\s\S]*data-back-view="reading"/);
  assert.match(html, /id="completeView"[\s\S]*data-back-view="recheck"/);
});

test('back navigation restores the first step and keeps submitted-step return semantics', async () => {
  const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(view === 'judgment'\) \{[\s\S]*renderJudgmentLock\(\)[\s\S]*classList\.remove\('hidden'\)/);
  assert.match(app, /button\.dataset\.backView = submitted \? 'complete' : 'reading'/);
  assert.match(app, /button\.textContent = submitted \? '‹ 返回完成结果' : '‹ 返回阅读来源'/);
  assert.match(app, /const activeStage = \['recheck', 'complete'\]\.includes\(state\.view\)/);
});

test('reading challenge content flows with the page instead of being clipped in a desktop scroll box', async () => {
  const styles = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.reading-grid \{[^}]*align-items: start;/);
  assert.match(styles, /\.growth-panel \{ padding: 34px 30px; max-height: none; overflow: visible; \}/);
});

test('narrow mobile stage bar keeps every step inside the viewport', async () => {
  const styles = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
  assert.match(styles, /@media \(max-width: 360px\)[\s\S]*\.stage-bar/);
  assert.match(styles, /@media \(max-width: 360px\)[\s\S]*\.stage-item[^}]*min-width: 0/);
});

test('375px stage bar compacts before the final label reaches the viewport edge', async () => {
  const styles = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*\.stage-bar[^}]*overflow: hidden/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*\.stage-item b[^}]*width: 24px/);
});

test('direct-answer citations use the visible source route', async () => {
  const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  const start = app.indexOf("className: 'da-cite'");
  assert.ok(start >= 0, 'direct-answer citation button is missing');
  const block = app.slice(start, start + 240);
  assert.match(block, /onclick: \(\) => followSourceRoute\(c\.id\)/);
});

test('non-stream direct-answer success replaces the loading placeholder', async () => {
  const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /非流式成功响应不会经过 onChunk[\s\S]*if \(!r\.querySelector\('\.da-answer'\)\)[\s\S]*r\.innerHTML = ''/);
});

test('opening the root page does not automatically restore a previous research result', async () => {
  const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /loadHotChips\(\);\s*restorePersistedResearchState\(\);/);
});

test('result heading keeps the home link and progress indicator in separate layout slots', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../../styles.css', import.meta.url), 'utf8');
  assert.match(html, /class="journey-heading-actions"[\s\S]*id="resultsHomeLink"[\s\S]*class="journey-progress"/);
  assert.match(styles, /\.journey-heading-actions\s*\{[^}]*display:\s*flex/);
  assert.doesNotMatch(styles, /\.journey-progress\s*\{[^}]*position:\s*absolute/);
});
