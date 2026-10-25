import type { ProviderConfig } from '../../shared/types.ts';
import { authHeaders, getJson, ProviderError } from '../adapters/http.ts';

/**
 * 尽力获取模型列表：并非所有供应商都提供该接口，失败时由前端提示手动输入模型 ID。
 * 只做 GET 查询，地址同样经过 SSRF 校验。
 */
function modelsUrl(cfg: ProviderConfig): string {
  const base = cfg.baseUrl.trim().replace(/\/+$/, '')
    .replace(/\/(chat\/completions|responses|messages)$/i, '')
    .replace(/\/models\/[^/]+:generateContent$/i, '');
  if (cfg.protocol === 'anthropic') return /\/v\d+[a-z0-9]*$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  return `${base}/models`;
}

export async function listModels(cfg: ProviderConfig, apiKey: string | undefined): Promise<{ ok: boolean; models: string[]; message: string }> {
  try {
    const headers = { ...authHeaders(cfg.authMode, apiKey), ...(cfg.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) };
    const { json } = await getJson(modelsUrl(cfg), headers, { signal: new AbortController().signal, timeoutMs: 20_000, secrets: [apiKey] });
    const raw: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
    const models = [...new Set(raw.map((m: any) => String(typeof m === 'string' ? m : m?.id ?? m?.name ?? '').replace(/^models\//, '')).filter(Boolean))].sort();
    if (!models.length) return { ok: false, models: [], message: '接口没有返回模型列表，请手动输入模型 ID。' };
    return { ok: true, models: models.slice(0, 1000), message: `获取到 ${models.length} 个模型。` };
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : '请求失败';
    return { ok: false, models: [], message: `该供应商可能不支持模型列表查询（${msg}），请手动输入模型 ID。` };
  }
}
