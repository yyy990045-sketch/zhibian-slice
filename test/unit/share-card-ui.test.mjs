import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('share card resets canvas text alignment before drawing challenge copy', async () => {
  const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('// 成长卡要点');
  const end = app.indexOf('// 底栏：数据来源徽标 + tagline', start);
  assert.ok(start >= 0 && end > start, 'share-card challenge drawing block is missing');
  const block = app.slice(start, end);
  assert.match(block, /ctx\.textAlign = 'left';[\s\S]*ctx\.fillText\('来源挑战 · 值得检查的前提'/);
  assert.match(block, /ctx\.textAlign = 'left';[\s\S]*ctx\.fillText\(label, 80, yy - 2\)/);
  assert.match(block, /ctx\.textAlign = 'left';[\s\S]*ctx\.fillText\(ln, 80, yy \+ 30/);
});

test('share card reserves the footer before drawing variable challenge text', async () => {
  const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('// 成长卡要点');
  const end = app.indexOf('// 底栏：数据来源徽标 + tagline', start);
  const block = app.slice(start, end);
  assert.match(block, /const footerTop = H - 150/);
  assert.match(block, /footerTop[\s\S]*textLines/);
});
