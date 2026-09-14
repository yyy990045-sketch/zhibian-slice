import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

// 这些断言守住热榜展示、真实模式降级和公开运行说明的边界。

test('首页热榜列表不丢弃真实条目，并提供可访问的展开入口', () => {
  assert.match(page, /<span class="hot-label" id="hotLabel">知乎热榜示例 · 演示<\/span>/);
  assert.match(page, /id="hotToggle" hidden aria-controls="hotList"/);
  assert.match(page, /<ol class="hot-list" id="hotList"><\/ol>/);
  assert.match(app, /const HOT_CHIPS_COLLAPSED = 6;/);
  assert.match(app, /function setHotLabel\(\) \{[\s\S]*?dataStatus\(\)\.hot/);
  assert.match(app, /await adapter\.hotList\(\{ limit: 30 \}\)/);
  assert.match(app, /function hotRow\(item, index\) \{[\s\S]*?className: 'hot-item'[\s\S]*?type: 'button',[\s\S]*?className: 'hot-link'/);
  assert.match(app, /String\(index \+ 1\)\.padStart\(2, '0'\)/);
  // 不用固定数量直接吃掉剩余真实条目。
  assert.doesNotMatch(app, /res\.items\.slice\(0, 12\)/);
  assert.match(app, /res\.items\.slice\(0, HOT_CHIPS_COLLAPSED\)/);
  assert.match(app, /const rest = res\.items\.slice\(HOT_CHIPS_COLLAPSED\)/);
  assert.match(app, /toggle\.hidden = true;[\s\S]*?toggle\.onclick = null;[\s\S]*?toggle\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(app, /展开全部 \$\{res\.items\.length\} 条/);
  assert.match(app, /restNodes\.forEach\(\(node\) => listEl\.append\(node\)\)/);
  assert.match(app, /restNodes\.forEach\(\(node\) => node\.remove\(\)\)/);
  assert.match(app, /toggle\.textContent = '收起'/);
  assert.match(app, /setAttribute\('aria-expanded', 'true'\)/);
  assert.match(css, /\.hot-list \{[\s\S]*?list-style: none;/);
  assert.match(css, /\.hot-link:focus-visible \{/);
});

test('真实模式热榜失败时给出降级文案而不是整块静默隐藏', () => {
  assert.match(app, /if \(!liveProvider\) \{[\s\S]*?box\.classList\.add\('hidden'\);[\s\S]*?return;/);
  assert.match(app, /hot-degraded/);
  assert.match(app, /publicMessage\(res\.reason, '知乎热榜暂时不可用，可以先试试上面的示例话题。'\)/);
  assert.match(css, /\.hot-degraded \{[^}]*display: inline-block;/);
});

test('页面注入的 provider 与代理解析共用同一事实源', () => {
  assert.match(server, /const provider = resolveProvider\(process\.env\.ZHIBIAN_PROVIDER \|\| '', \{/);
  assert.match(server, /const server = createAppServer\(\{ provider \}\);/);
  assert.doesNotMatch(server, /process\.env\.ZHIBIAN_PROVIDER === 'cli' \? 'cli'/);
  assert.match(server, /生产形态运行在 mock（演示数据）模式/);
});

test('公开运行说明不要求把凭证写入仓库', () => {
  assert.match(readme, /\.env\.example/);
  assert.match(readme, /凭证只应注入服务端环境/);
  assert.match(readme, /不要把真实值写入/);
});
