import { hostOf, resolveEndpoint } from '../../shared/endpoint.ts';
import { PROTOCOLS, type AuthMode, type ProtocolId, type ProviderConfig, type ProviderDraft } from '../../shared/types.ts';
import { assertAllowedUrl, UrlPolicyError } from '../security/url.ts';
import { listModels } from './models.ts';

export class DraftError extends Error {}

export function normalizeDraft(d: ProviderDraft): Pick<ProviderConfig, 'name' | 'protocol' | 'baseUrl' | 'authMode' | 'maxConcurrentRequests'> {
  const protocol = PROTOCOLS.find((p) => p.id === d.protocol)?.id as ProtocolId | undefined;
  if (!protocol) throw new DraftError('请选择接口协议');
  const baseUrl = String(d.baseUrl ?? '').trim();
  if (!baseUrl) throw new DraftError('请填写 API 地址');
  try {
    assertAllowedUrl(resolveEndpoint(protocol, baseUrl, 'model') || baseUrl);
  } catch (e) {
    throw new DraftError(e instanceof UrlPolicyError ? e.message : 'API 地址格式不正确');
  }
  const name = String(d.name ?? '').trim() || hostOf(baseUrl);
  if (name.length > 60) throw new DraftError('名称不超过 60 字');
  const authModes: AuthMode[] = ['bearer', 'x-api-key', 'x-goog-api-key', 'none'];
  const authMode = d.authMode && authModes.includes(d.authMode) ? d.authMode : PROTOCOLS.find((p) => p.id === protocol)!.defaultAuth;
  let maxConcurrentRequests: number | null = null;
  if (d.maxConcurrentRequests !== null && d.maxConcurrentRequests !== undefined && String(d.maxConcurrentRequests) !== '') {
    const n = Number(d.maxConcurrentRequests);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new DraftError('最大并发请求数应为 1～64 的整数');
    maxConcurrentRequests = n;
  }
  return { name, protocol, baseUrl, authMode, maxConcurrentRequests };
}

function normalizeModels(list: unknown, limit: number): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((m) => String(m).trim()).filter((m) => m && m.length <= 200))].slice(0, limit);
}

function validateKey(apiKey: unknown): string | undefined {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return undefined;
  if (key.length > 4096 || /\s/.test(key)) throw new DraftError('API Key 格式不正确');
  return key;
}

/** Validate a browser-supplied provider before using it for one request. */
export function normalizeProvider(input: unknown): ProviderConfig {
  const p = (input ?? {}) as Partial<ProviderConfig>;
  const base = normalizeDraft({
    name: p.name,
    protocol: p.protocol as ProtocolId,
    baseUrl: String(p.baseUrl ?? ''),
    authMode: p.authMode,
    maxConcurrentRequests: p.maxConcurrentRequests,
  });
  const id = String(p.id ?? '').trim();
  if (!id || id.length > 128) throw new DraftError('供应商标识无效');
  return {
    ...base,
    id,
    models: normalizeModels(p.models, 1000),
    manualModels: normalizeModels(p.manualModels, 200),
    modelsFetchedAt: typeof p.modelsFetchedAt === 'string' ? p.modelsFetchedAt : null,
    modelsError: typeof p.modelsError === 'string' ? p.modelsError.slice(0, 500) : null,
    keySource: 'browser',
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
  };
}

export function modelsOf(c: ProviderConfig): string[] {
  return [...new Set([...c.models, ...c.manualModels])];
}

/** Query models with a browser-supplied config and return only non-secret data. */
export async function refreshProvider(input: unknown, apiKeyInput: unknown): Promise<ProviderConfig> {
  const cfg = normalizeProvider(input);
  const apiKey = validateKey(apiKeyInput);
  const r = !apiKey && cfg.authMode !== 'none'
    ? { ok: false, models: [], message: '尚未设置 API Key' }
    : await listModels(cfg, apiKey);
  return {
    ...cfg,
    models: r.ok ? r.models : cfg.models,
    modelsError: r.ok ? null : r.message,
    modelsFetchedAt: new Date().toISOString(),
    keySource: apiKey || cfg.authMode === 'none' ? 'browser' : 'none',
  };
}

/** Validate a key at the request boundary without retaining it. */
export function validateApiKey(apiKey: unknown): string | undefined { return validateKey(apiKey); }
