// logger.js — 结构化 JSON 日志 + PII 脱敏（敏感字段深度脱敏）
// 目的：服务端日志统一为 JSON 行；token/secret/password/手机/微信/邮箱等敏感字段脱敏后才输出。
// 纯函数可测；生产环境（NODE_ENV=production）仅输出 warn/error，避免日志噪声。

// PII/敏感字段名匹配（脱敏触发键）
const SENSITIVE_KEYS = /(token|secret|password|passwd|authorization|cookie|phone|mobile|tel|wechat|weixin|email|mail)/i;

// 深度脱敏：敏感键的值替换为 [REDACTED]；数组/对象递归处理
export function maskSensitive(value, depth = 0) {
  if (depth > 4) return '[MAX_DEPTH]';
  if (value == null) return value;
  if (typeof value === 'string') return value; // 叶子值按键名在上层脱敏
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : maskSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

// 脱敏一个请求参数对象（query/body 通用入口）
export function sanitizePayload(payload) {
  return maskSensitive(payload);
}

// 结构化 JSON 日志：单行输出，含 level/msg/时间与附加字段
export function jsonLog(level, msg, fields = {}) {
  if (process.env.NODE_ENV === 'production' && (level === 'debug' || level === 'info')) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  return line; // 便于测试断言
}
