import type { BrowserProvider, ProviderConfig, ProviderDraft } from '../../shared/types.ts';
import { api } from './api.ts';

const STORE_KEY = 'cube-arena-providers';
const SESSION_COOKIE = 'cube_arena_browser_session';
const LOCK_NAME = 'cube-arena-provider-storage';

export const PROVIDER_STORAGE_NOTICE = '配置与密钥仅保存在本浏览器，刷新或关闭标签页不会清除；浏览器会话结束后失效。启用“恢复上次会话”时可能一并恢复。服务端仅在请求或评测期间临时使用，不保存配置与密钥。';

interface ProviderStorage {
  sessionId: string;
  providers: BrowserProvider[];
}

function cookieSession(): string | undefined {
  const value = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return value && /^[0-9a-f-]{36}$/.test(value) ? value : undefined;
}

function readStorage(): ProviderStorage {
  let sessionId = cookieSession();
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    // Only a random lifetime marker goes in the cookie, never a config or key.
    // Omitting Expires/Max-Age makes its lifetime follow the browser session.
    document.cookie = `${SESSION_COOKIE}=${sessionId}; Path=/; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
    if (cookieSession() !== sessionId) throw new Error('请允许本网站使用 Cookie，才能保存当前浏览器会话的供应商配置');
    localStorage.removeItem(STORE_KEY);
  }
  const raw = localStorage.getItem(STORE_KEY);
  if (raw === null) return { sessionId, providers: [] };
  let saved: ProviderStorage;
  try {
    saved = JSON.parse(raw) as ProviderStorage;
  } catch (cause) {
    throw new Error('浏览器中的供应商配置已损坏，无法读取', { cause });
  }
  if (!saved || typeof saved !== 'object' || typeof saved.sessionId !== 'string') throw new Error('浏览器中的供应商配置格式不正确');
  if (saved.sessionId !== sessionId) {
    localStorage.removeItem(STORE_KEY);
    return { sessionId, providers: [] };
  }
  if (!Array.isArray(saved.providers)) throw new Error('浏览器中的供应商配置格式不正确');
  return saved;
}

async function withProviders<T>(fn: (saved: ProviderStorage) => T, write = false): Promise<T> {
  if (!navigator.locks) throw new Error('当前环境不支持浏览器会话存储，请使用新版浏览器并通过 HTTPS 或 localhost 访问');
  // Serialize initialization and read-modify-write across tabs. Never hold the
  // lock while waiting for a provider's network response.
  return navigator.locks.request(LOCK_NAME, () => {
    const saved = readStorage();
    const result = fn(saved);
    if (write) localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    return result;
  });
}

export function loadProviders(): Promise<BrowserProvider[]> {
  return withProviders((saved) => saved.providers);
}

export function subscribeProviders(onChanged: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === STORE_KEY || event.key === null)) onChanged();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', onChanged);
  window.addEventListener('pageshow', onChanged);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', onChanged);
    window.removeEventListener('pageshow', onChanged);
  };
}

export function publicConfig(p: BrowserProvider): ProviderConfig {
  const { apiKey: _apiKey, ...config } = p;
  return config;
}

function providerFromDraft(draft: ProviderDraft, previous?: BrowserProvider): BrowserProvider {
  const connectionChanged = previous && (
    draft.protocol !== previous.protocol || draft.baseUrl.trim() !== previous.baseUrl ||
    draft.authMode !== previous.authMode || Boolean(draft.apiKey?.trim())
  );
  const apiKey = draft.apiKey?.trim() || previous?.apiKey || '';
  return {
    id: previous?.id ?? crypto.randomUUID(),
    name: draft.name ?? previous?.name ?? '',
    protocol: draft.protocol,
    baseUrl: draft.baseUrl.trim(),
    authMode: draft.authMode ?? previous?.authMode ?? 'bearer',
    maxConcurrentRequests: draft.maxConcurrentRequests ?? null,
    models: connectionChanged ? [] : previous?.models ?? [],
    manualModels: draft.manualModels ?? previous?.manualModels ?? [],
    modelsFetchedAt: connectionChanged ? null : previous?.modelsFetchedAt ?? null,
    modelsError: connectionChanged ? null : previous?.modelsError ?? null,
    keySource: apiKey ? 'browser' : 'none',
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    apiKey,
  };
}

async function queryModels(provider: BrowserProvider): Promise<BrowserProvider> {
  const refreshed = await api.refreshModels(publicConfig(provider), provider.apiKey);
  return { ...refreshed, apiKey: provider.apiKey };
}

function getProvider(saved: ProviderStorage, id: string): BrowserProvider {
  const provider = saved.providers.find((p) => p.id === id);
  if (!provider) throw new Error('该供应商不存在，请刷新后重试');
  return provider;
}

async function replaceProvider(previous: BrowserProvider, provider: BrowserProvider, sessionId: string): Promise<BrowserProvider> {
  return withProviders((saved) => {
    if (saved.sessionId !== sessionId) throw new Error('浏览器会话已结束，请重新配置供应商');
    const current = getProvider(saved, previous.id);
    if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('该供应商已在其他页面修改，请刷新后重试');
    saved.providers[saved.providers.indexOf(current)] = provider;
    return provider;
  }, true);
}

export async function createProvider(draft: ProviderDraft): Promise<BrowserProvider> {
  const sessionId = await withProviders((saved) => saved.sessionId);
  const provider = await queryModels(providerFromDraft(draft));
  return withProviders((saved) => {
    if (saved.sessionId !== sessionId) throw new Error('浏览器会话已结束，请重新配置供应商');
    saved.providers.push(provider);
    return provider;
  }, true);
}

export async function updateProvider(id: string, draft: ProviderDraft): Promise<BrowserProvider> {
  const { previous, sessionId } = await withProviders((saved) => ({ previous: getProvider(saved, id), sessionId: saved.sessionId }));
  const provider = await queryModels(providerFromDraft(draft, previous));
  return replaceProvider(previous, provider, sessionId);
}

export async function deleteProvider(id: string): Promise<void> {
  await withProviders((saved) => {
    const provider = getProvider(saved, id);
    saved.providers.splice(saved.providers.indexOf(provider), 1);
  }, true);
}

export async function duplicateProvider(id: string): Promise<BrowserProvider> {
  return withProviders((saved) => {
    const source = getProvider(saved, id);
    const now = new Date().toISOString();
    const copy = { ...source, id: crypto.randomUUID(), name: `${source.name} 副本`.slice(0, 60), createdAt: now, updatedAt: now };
    saved.providers.push(copy);
    return copy;
  }, true);
}

export async function refreshProvider(id: string): Promise<BrowserProvider> {
  const { previous, sessionId } = await withProviders((saved) => ({ previous: getProvider(saved, id), sessionId: saved.sessionId }));
  const provider = await queryModels(previous);
  return replaceProvider(previous, provider, sessionId);
}

export async function testProvider(id: string, model: string) {
  const provider = await withProviders((saved) => getProvider(saved, id));
  return api.testProvider(publicConfig(provider), provider.apiKey, model);
}
