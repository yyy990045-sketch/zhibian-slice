// audit.js — 审计日志（US-09）
// 目的：为「可追溯性」提供结构化审计记录：谁（IP/来源）、何时、调了哪个端点、结果如何。
//   - 内存环形缓冲（默认 200 条，防内存无限增长；可配置落盘文件）
//   - 敏感字段脱敏（query / body / Authorization 一律脱敏，只留摘要形态）
//   - 纯函数 toAuditEntry 便于单测；审计绝不包含 Secret / token / 用户正文。
//
// 诚实边界：审计是「操作记录」不是「用户画像」——不做跨请求关联分析、不存正文全文。

import { readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// 脱敏：仅保留长度信息与首尾字符，中间用 * 掩码
export function mask(value, { keep = 2, max = 32 } = {}) {
  const s = String(value ?? '');
  if (!s) return '';
  const body = s.length > max ? s.slice(0, max) : s;
  if (keep === 0) return '*'.repeat(body.length);
  if (body.length <= keep * 2) return '*'.repeat(body.length);
  return body.slice(0, keep) + '*'.repeat(Math.max(3, body.length - keep * 2)) + body.slice(-keep);
}

// 构造审计条目（纯函数，供单测与 server 接入共用）
export function toAuditEntry({ reqId, method, path, origin, ip, status, ms, query = {}, body = {} } = {}) {
  return {
    ts: new Date().toISOString(),
    reqId: mask(reqId || '', { keep: 6 }),
    method: String(method || '').toUpperCase(),
    path,
    origin: mask(origin || '', { keep: 12 }),
    ip: mask(ip || '', { keep: 0 }),
    status,
    ms,
    // query / body 只留字段名与脱敏值；真实正文一律不进审计
    query: Object.fromEntries(Object.entries(query || {}).map(([k, v]) => [k, mask(v, { keep: 1 })])),
    bodyKeys: Object.keys(body || {}).slice(0, 8),
  };
}

// 审计记录器：环形缓冲 + 可选落盘（append-only）
export function createAuditLog({ capacity = 200, file = null } = {}) {
  const ring = [];
  let seq = 0;
  let writeQueue = Promise.resolve();

  if (file) {
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const restored = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry === 'object' && entry.path) restored.push(entry);
        } catch {
          // append-only 文件可能在进程中断时留下半行；跳过坏行，保留其余历史。
        }
      }
      for (const entry of restored.slice(-capacity)) {
        ring.push(entry);
        seq = Math.max(seq, Number(entry.seq) || 0);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') ring.push({ type: 'audit_read_error', ts: new Date().toISOString(), error: String(error.message || error) });
    }
  }

  const persist = (entry) => {
    if (!file) return;
    writeQueue = writeQueue.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, JSON.stringify(entry) + '\n', 'utf-8');
      } catch (e) {
        // 落盘失败静默（审计不阻断业务），计数留痕
        ring.push({ type: 'audit_write_error', ts: new Date().toISOString(), error: String(e.message || e) });
      }
    }).catch(() => {});
  };

  return {
    record(entry) {
      const normalized = toAuditEntry(entry);
      normalized.seq = ++seq;
      if (ring.length >= capacity) ring.shift();
      ring.push(normalized);
      persist(normalized);
      return normalized;
    },
    // 快照（复制，防外部改写）
    snapshot() {
      return { count: ring.length, entries: ring.slice() };
    },
    clear() {
      ring.length = 0;
    },
    // 等待当前批次异步落盘完成，供优雅停机和验收使用。
    flush() { return writeQueue; },
    // 供测试观测落盘错误计数
    _seq() { return seq; },
  };
}
