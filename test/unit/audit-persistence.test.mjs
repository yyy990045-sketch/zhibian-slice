import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLog, mask, toAuditEntry } from '../../src/audit.js';

test('审计 IP 在 keep=0 时不会泄露原文', () => {
  const entry = toAuditEntry({ ip: '203.0.113.7', path: '/api/zhihu/stats' });
  assert.equal(entry.ip, '***********');
  assert.ok(!entry.ip.includes('203.0.113.7'));
  assert.equal(mask('secret', { keep: 0 }), '******');
});

test('审计落盘后可在新实例恢复，且继续使用递增序号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhibian-audit-'));
  const file = join(dir, 'nested', 'audit.ndjson');
  try {
    const first = createAuditLog({ capacity: 2, file });
    first.record({ reqId: 'first', method: 'GET', path: '/api/zhihu/stats' });
    await first.flush();
    const second = createAuditLog({ capacity: 2, file });
    assert.equal(second.snapshot().count, 1);
    assert.equal(second.snapshot().entries[0].path, '/api/zhihu/stats');
    const restoredSeq = second.snapshot().entries[0].seq;
    const next = second.record({ reqId: 'second', method: 'GET', path: '/api/zhihu/audit' });
    assert.equal(next.seq, restoredSeq + 1);
    await second.flush();
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('审计文件含损坏行时保留其他有效记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhibian-audit-corrupt-'));
  const file = join(dir, 'audit.ndjson');
  try {
    await writeFile(file, `${JSON.stringify({ seq: 7, path: '/api/zhihu/stats' })}\n{"seq":8,"path":\n`, 'utf8');
    const log = createAuditLog({ capacity: 2, file });
    assert.equal(log.snapshot().count, 1);
    assert.equal(log.snapshot().entries[0].path, '/api/zhihu/stats');
    assert.equal(log._seq(), 7);
    assert.equal(log.record({ method: 'GET', path: '/api/zhihu/hot' }).seq, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
