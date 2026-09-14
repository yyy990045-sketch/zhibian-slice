// providers.js — LLM 网关注册表（US-15）
// 目的：把「直答 Agent / 升级判定 / 摘要」用到的模型与厂商配置收敛为单一事实源，
//       避免 server.mjs、app.js、评估脚本各自硬编码模型名/超参导致漂移。
//
// 诚实边界：真实调用的鉴权与 Secret 只存在于服务端环境（ZHIHU_ACCESS_SECRET），
//       本模块只做「配置注册与解析」，绝不持有任何密钥；直答真实模式是否可用
//       由 server.mjs 的 env 门禁（validateEnv）判定，本模块不绕过。

// 直答默认模型（与 server.mjs 现状保持一致，收敛到此处）
export const DEFAULT_DIRECT_MODEL = 'zhida-thinking-1p5';

// 模型注册表：name → 定义（单一事实源；新增模型只改这里）
export const LLM_PROVIDER_REGISTRY = {
  'zhida-thinking-1p5': {
    vendor: 'zhihu',
    capability: 'direct_answer',
    maxTokens: 2048,
    stream: true,
    notes: '知乎直答 Agent（开放平台），默认真实模式模型',
  },
};

// provider 配置注册表：http 真实通道 / mock 降级通道
export const PROVIDER_CONFIG = {
  http: {
    label: '真实数据（知乎开放平台）',
    directEndpoint: '/v1/chat/completions',
    requiresSecret: true,
  },
  cli: {
    label: '真实数据（官方 zhihu-cli）',
    directEndpoint: '/v1/chat/completions',
    requiresSecret: false,
  },
  mock: {
    label: '演示数据（内置示例）',
    directEndpoint: null,
    requiresSecret: false,
  },
};

// 解析模型定义；未知模型返回 null（不静默 fallback，调用方显式处理）
export function resolveProviderDefinition(modelName) {
  return LLM_PROVIDER_REGISTRY[modelName] || null;
}

// 按模型名取模型（DEFAULT_DIRECT_MODEL 兜底，供 server/评估脚本统一引用）
export function getProviderByModelName(modelName) {
  const resolved = resolveProviderDefinition(modelName || DEFAULT_DIRECT_MODEL);
  return resolved || LLM_PROVIDER_REGISTRY[DEFAULT_DIRECT_MODEL];
}

// 校验 provider 模式：仅接受 'http' | 'mock'
export function isProviderMode(mode) {
  return mode === 'http' || mode === 'cli' || mode === 'mock';
}

// maxTokens 钳制（防超配额/超大生成；范围校验，非法值回退默认）
export function clampMaxTokens(modelName, requested, { min = 64, max = 8192 } = {}) {
  const def = getProviderByModelName(modelName);
  const cap = def?.maxTokens || 2048;
  const n = Number(requested);
  if (!Number.isFinite(n) || n < min) return cap;
  return Math.min(n, max, cap);
}

// 该 provider 是否要求 Secret（用于 env 门禁/UI 提示的单一事实源）
export function providerRequiresSecret(mode) {
  return Boolean(PROVIDER_CONFIG[mode]?.requiresSecret);
}
