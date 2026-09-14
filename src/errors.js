// errors.js — 统一错误码与公共降级文案（单出口，错误码集中声明）
// 目的：降级态文案收敛为单一事实源，禁止各处散落 reason 字符串/文案；诚实披露，不夸大。
// 浏览器侧所有降级提示均经 publicMessage() 输出；场景化覆盖用 fallback 参数，缺省回公共文案。

// 与 adapter.js 返回的 reason 值一一对应（契约，勿改字符串值）
export const ERROR_CODES = {
  NOT_CONFIGURED: 'not_configured',            // 服务端未配置真实 API
  OAUTH_SESSION_REQUIRED: 'oauth_session_required', // 用户数据接口需 OAuth 会话（未启用）
  OAUTH_SESSION_EXPIRED: 'oauth_session_expired',   // 用户会话过期或服务重启
  OAUTH_NOT_CONFIGURED: 'oauth_not_configured',     // 服务器未配置 OAuth 凭证
  QUOTA_EXHAUSTED: 'quota_exhausted',          // 今日配额用完
  NO_RESULT: 'no_result',                      // 无检索结果
  API_ERROR: 'api_error',                      // 上游接口异常
  NETWORK_ERROR: 'network_error',              // 网络异常
  INVALID_REQUEST: 'invalid_request',          // 请求非法（服务端 400）
};

// 公共降级文案（诚实口径：不把降级说成成功，不夸大能力）
export const PUBLIC_MESSAGES = {
  not_configured: '服务端尚未配置真实 API。当前为离线示例数据。',
  oauth_session_required: '该能力需要独立的 OAuth 安全会话（尚未启用）。',
  oauth_session_expired: '知乎授权已过期或服务已重启，请重新登录后继续。',
  oauth_not_configured: '收藏夹校准暂未配置完成，请稍后再试。',
  quota_exhausted: '今日知乎额度已用完，暂时无法发起新的请求；当前页面已加载的结果仍可查看。',
  no_result: '未检索到相关讨论。换个更具体的问法，或试试示例话题。',
  api_error: '接口返回异常，已安全降级。',
  network_error: '网络异常，已安全降级。请检查连接后重试。',
  invalid_request: '请求无效，请调整后重试。',
};

// 单出口：场景可传 fallback 覆盖，缺省回公共文案，再兜底通用语
export function publicMessage(code, fallback = null) {
  return fallback || PUBLIC_MESSAGES[code] || '暂时无法获取数据。';
}
