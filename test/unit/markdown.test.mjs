import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, renderMarkdown } from '../../src/markdown.js';

test('markdown parser separates headings, lists, and tables', () => {
  const blocks = parseMarkdown('## 结论\n\n**重点**\n\n- 第一条\n- 第二条\n\n| 维度 | 结论 |\n| --- | --- |\n| 风险 | 可控 |');
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'unordered-list', 'table']);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(blocks[2].items, ['第一条', '第二条']);
  assert.deepEqual(blocks[3].header, ['维度', '结论']);
  assert.deepEqual(blocks[3].rows, [['风险', '可控']]);
});

test('markdown parser keeps raw HTML as text', () => {
  const [block] = parseMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(block.type, 'paragraph');
  assert.equal(block.text, '<img src=x onerror=alert(1)>');
});

test('markdown parser handles ordered lists, quotes, CRLF, and plus markers', () => {
  const blocks = parseMarkdown('说明\r\n\r\n+ 甲\r\n+ 乙\r\n\r\n1. 第一步\r\n2) 第二步\r\n\r\n> 注意条件');
  assert.deepEqual(blocks.map((block) => block.type), ['paragraph', 'unordered-list', 'ordered-list', 'quote']);
  assert.deepEqual(blocks[1].items, ['甲', '乙']);
  assert.deepEqual(blocks[2].items, ['第一步', '第二步']);
  assert.equal(blocks[3].text, '注意条件');
});

test('markdown renderer builds safe DOM for every supported block type', () => {
  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this._textContent = '';
    }

    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    set textContent(value) { this._textContent = String(value); this.children = []; }
    get textContent() { return this._textContent || this.children.map((node) => node.textContent || '').join(''); }
  }

  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeNode(tagName),
    createTextNode: (text) => ({ textContent: String(text) }),
  };
  try {
    const container = new FakeNode('div');
    assert.equal(renderMarkdown(null), null);
    assert.equal(renderMarkdown(container, [
      '# 标题',
      '',
      '段落 **加粗** __强调__ *斜体* _倾斜_ `代码` [来源](https://example.com/source)',
      '',
      '- 无序一',
      '- 无序二',
      '',
      '1. 有序一',
      '2) 有序二',
      '',
      '> 引用内容',
      '',
      '| 维度 | 结论 |',
      '| --- | --- |',
      '| 风险 | 可控 |',
    ].join('\n')), container);

    assert.deepEqual(container.children.map((node) => node.tagName), ['H1', 'P', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE']);
    const paragraph = container.children[1];
    assert.equal(paragraph.children.filter((node) => node.tagName === 'STRONG').length, 2);
    assert.equal(paragraph.children.filter((node) => node.tagName === 'EM').length, 2);
    assert.equal(paragraph.children.filter((node) => node.tagName === 'CODE').length, 1);
    assert.equal(paragraph.children.filter((node) => node.tagName === 'A').length, 1);
    assert.equal(container.children[2].children.length, 2);
    assert.equal(container.children[3].children.length, 2);
    assert.equal(container.children[5].children[0].tagName, 'THEAD');
    assert.equal(container.children[5].children[1].tagName, 'TBODY');
  } finally {
    globalThis.document = previousDocument;
  }
});
