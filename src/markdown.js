// Small, safe Markdown renderer for the direct-answer panel.
// It intentionally supports only the structures shown in the UI and never
// assigns caller text to innerHTML.

function splitTableRow(line) {
  const value = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return value.split('|').map((cell) => cell.trim());
}

function isTableDelimiter(line) {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseMarkdown(markdown = '') {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    if (line.includes('|') && lines[index + 1] && isTableDelimiter(lines[index + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      const items = [unordered[1].trim()];
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\s*[-*+]\s+(.+)$/);
        if (!next) break;
        items.push(next[1].trim());
        index += 1;
      }
      blocks.push({ type: 'unordered-list', items });
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      const items = [ordered[1].trim()];
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!next) break;
        items.push(next[1].trim());
        index += 1;
      }
      blocks.push({ type: 'ordered-list', items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph();
      blocks.push({ type: 'quote', text: line.replace(/^>\s?/, '').trim() });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

function appendInline(parent, value) {
  const text = String(value ?? '');
  const token = /(\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let cursor = 0;
  let match;
  while ((match = token.exec(text))) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    if (match[2] || match[3]) {
      const strong = document.createElement('strong');
      strong.textContent = match[2] || match[3];
      parent.append(strong);
    } else if (match[4]) {
      const code = document.createElement('code');
      code.textContent = match[4];
      parent.append(code);
    } else if (match[5] || match[6]) {
      const emphasis = document.createElement('em');
      emphasis.textContent = match[5] || match[6];
      parent.append(emphasis);
    } else if (match[7] && match[8]) {
      const link = document.createElement('a');
      link.textContent = match[7];
      link.href = match[8];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.append(link);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function appendInlineWithBreaks(parent, text) {
  String(text).split('\n').forEach((line, index, all) => {
    appendInline(parent, line);
    if (index < all.length - 1) parent.append(document.createElement('br'));
  });
}

export function renderMarkdown(container, markdown = '') {
  if (!container) return container;
  container.replaceChildren();
  for (const block of parseMarkdown(markdown)) {
    if (block.type === 'heading') {
      const node = document.createElement(`h${Math.min(block.level, 6)}`);
      appendInline(node, block.text);
      container.append(node);
    } else if (block.type === 'unordered-list' || block.type === 'ordered-list') {
      const node = document.createElement(block.type === 'unordered-list' ? 'ul' : 'ol');
      for (const item of block.items) {
        const li = document.createElement('li');
        appendInlineWithBreaks(li, item);
        node.append(li);
      }
      container.append(node);
    } else if (block.type === 'table') {
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      for (const cell of block.header) {
        const th = document.createElement('th');
        appendInlineWithBreaks(th, cell);
        headerRow.append(th);
      }
      thead.append(headerRow);
      table.append(thead);
      const tbody = document.createElement('tbody');
      for (const row of block.rows) {
        const tr = document.createElement('tr');
        for (let index = 0; index < block.header.length; index += 1) {
          const td = document.createElement('td');
          appendInlineWithBreaks(td, row[index] || '');
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      container.append(table);
    } else if (block.type === 'quote') {
      const quote = document.createElement('blockquote');
      appendInlineWithBreaks(quote, block.text);
      container.append(quote);
    } else {
      const paragraph = document.createElement('p');
      appendInlineWithBreaks(paragraph, block.text);
      container.append(paragraph);
    }
  }
  return container;
}
