import type { ProtocolId } from './types.ts';

/**
 * 根据 Base URL 与协议计算最终请求地址（前端预览与后端请求共用）。
 * 规则：
 * - 不写死任何官方域名，不自动追加 /v1（OpenAI 兼容协议约定 Base URL 已包含版本路径）；
 * - 若用户直接填写了完整端点（已以协议路径结尾），原样使用，避免重复拼接；
 * - Anthropic 协议仅在 Base URL 未包含 /v1 时补 /v1，避免出现 /v1/v1。
 */
export function resolveEndpoint(protocol: ProtocolId, baseUrl: string, model: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) return '';
  switch (protocol) {
    case 'openai-chat':
      return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
    case 'openai-responses':
      return /\/responses$/i.test(base) ? base : `${base}/responses`;
    case 'anthropic':
      if (/\/messages$/i.test(base)) return base;
      return /\/v\d+[a-z0-9]*$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
    case 'gemini': {
      if (/:generateContent$/i.test(base)) return base;
      const m = encodeURIComponent(model.trim().replace(/^models\//, ''));
      return /\/models$/i.test(base) ? `${base}/${m}:generateContent` : `${base}/models/${m}:generateContent`;
    }
  }
}

/** 去掉查询串与凭据，仅保留可展示的地址 */
export function displayEndpoint(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    return u.toString();
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
