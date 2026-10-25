import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hostOf, resolveEndpoint } from '../../shared/endpoint.ts';
import { PROTOCOLS, type AuthMode, type ProtocolId, type ProviderConfig, type ProviderDraft } from '../../shared/types.ts';
import { encryptionAvailable, seal, unseal, type Sealed } from '../security/crypto.ts';
import { assertAllowedUrl, UrlPolicyError } from '../security/url.ts';
import { listModels } from './models.ts';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '../../data'));
const CONFIG_FILE = path.join(DATA_DIR, 'providers.json');
const SECRET_FILE = path.join(DATA_DIR, 'credentials.json');

/** 默认仅保存在进程内存中，服务重启即失效 */
const memoryKeys = new Map<string, string>();
let configs: ProviderConfig[] = [];
let sealed: Record<string, Sealed> = {};
let loaded = false;

/** 旧版本按「每个模型一条配置」保存，按 协议 + Base URL 合并为一个供应商 */
function migrate(raw: unknown[]): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const r of raw as Record<string, any>[]) {
    if (Array.isArray(r.models)) {
      out.push({ manualModels: [], modelsFetchedAt: null, modelsError: null, maxConcurrentRequests: null, ...r } as unknown as ProviderConfig);
      continue;
    }
    const same = out.find((p) => p.protocol === r.protocol && p.baseUrl.replace(/\/+$/, '') === String(r.baseUrl).replace(/\/+$/, ''));
    if (same) {
      if (r.model && !same.manualModels.includes(r.model)) same.manualModels.push(r.model);
      continue;
    }
    out.push({
      id: r.id,
      name: hostOf(String(r.baseUrl)) || r.name,
      protocol: r.protocol,
      baseUrl: r.baseUrl,
      authMode: r.authMode ?? 'bearer',
      maxConcurrentRequests: r.maxConcurrentRequests ?? null,
      models: [],
      manualModels: r.model ? [r.model] : [],
      modelsFetchedAt: null,
      modelsError: null,
      keySource: 'none',
      createdAt: r.createdAt ?? new Date().toISOString(),
      updatedAt: r.updatedAt ?? new Date().toISOString(),
    });
  }
  return out;
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    configs = migrate(JSON.parse(await readFile(CONFIG_FILE, 'utf8')));
  } catch {
    configs = [];
  }
  try {
    sealed = JSON.parse(await readFile(SECRET_FILE, 'utf8'));
  } catch {
    sealed = {};
  }
}

let writing = Promise.resolve();
function persist() {
  writing = writing.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(configs.map(({ keySource: _k, ...c }) => c), null, 2));
    await writeFile(SECRET_FILE, JSON.stringify(sealed, null, 2), { mode: 0o600 });
  });
  return writing;
}

const now = () => new Date().toISOString();

// ---------- 环境变量预置（只读，模型列表保存在内存中） ----------

interface EnvPreset {
  id: string;
  name: string;
  keyEnv: string;
  baseUrlEnv: string;
  baseUrl: string;
}

const ENV_PRESETS: EnvPreset[] = [
  { id: 'env-deepseek', name: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', baseUrlEnv: 'DEEPSEEK_BASE_URL', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'env-qwen', name: '通义千问', keyEnv: 'DASHSCOPE_API_KEY', baseUrlEnv: 'DASHSCOPE_BASE_URL', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'env-kimi', name: 'Kimi', keyEnv: 'MOONSHOT_API_KEY', baseUrlEnv: 'MOONSHOT_BASE_URL', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'env-glm', name: '智谱 GLM', keyEnv: 'ZHIPU_API_KEY', baseUrlEnv: 'ZHIPU_BASE_URL', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'env-doubao', name: '豆包', keyEnv: 'ARK_API_KEY', baseUrlEnv: 'ARK_BASE_URL', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'env-minimax', name: 'MiniMax', keyEnv: 'MINIMAX_API_KEY', baseUrlEnv: 'MINIMAX_BASE_URL', baseUrl: 'https://api.minimaxi.com/v1' },
];

const envModels = new Map<string, Pick<ProviderConfig, 'models' | 'modelsFetchedAt' | 'modelsError'>>();

function envConfigs(): ProviderConfig[] {
  return ENV_PRESETS.filter((p) => process.env[p.keyEnv]).map((p) => ({
    id: p.id,
    name: `${p.name}（服务端预置）`,
    protocol: 'openai-chat' as const,
    baseUrl: process.env[p.baseUrlEnv] || p.baseUrl,
    authMode: 'bearer' as const,
    maxConcurrentRequests: null,
    models: [],
    manualModels: [],
    modelsFetchedAt: null,
    modelsError: null,
    ...envModels.get(p.id),
    readonly: true,
    keySource: 'env' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

function keySourceOf(id: string): ProviderConfig['keySource'] {
  if (memoryKeys.has(id)) return 'memory';
  if (sealed[id]) return 'encrypted';
  return 'none';
}

function allConfigs(): ProviderConfig[] {
  return [...envConfigs(), ...configs.map((c) => ({ ...c, keySource: keySourceOf(c.id) }))];
}

// ---------- 对外接口 ----------

export async function listConfigs(): Promise<ProviderConfig[]> {
  await load();
  // 预置供应商首次列出时在后台获取模型列表
  for (const e of envConfigs()) if (!envModels.has(e.id)) void refreshModels(e.id);
  return allConfigs();
}

export async function getConfig(id: string): Promise<ProviderConfig | undefined> {
  await load();
  return allConfigs().find((c) => c.id === id);
}

/** 仅供服务端发起请求时使用，绝不返回给前端 */
export async function getApiKey(id: string): Promise<string | undefined> {
  await load();
  const preset = ENV_PRESETS.find((p) => p.id === id);
  if (preset) return process.env[preset.keyEnv];
  if (memoryKeys.has(id)) return memoryKeys.get(id);
  if (sealed[id] && encryptionAvailable()) {
    try {
      return unseal(sealed[id]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 所有可选模型：自动获取的 + 手动补充的 */
export function modelsOf(c: ProviderConfig): string[] {
  return [...new Set([...c.models, ...c.manualModels])];
}

export class DraftError extends Error {}

/** 校验并规范化草稿（不含密钥） */
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

function normalizeManual(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((m) => String(m).trim()).filter((m) => m && m.length <= 200))].slice(0, 200);
}

function applyKey(id: string, d: ProviderDraft) {
  if (d.clearKey) {
    memoryKeys.delete(id);
    delete sealed[id];
  }
  const key = typeof d.apiKey === 'string' ? d.apiKey.trim() : '';
  if (!key) {
    if (d.persistKey === false && sealed[id]) {
      // 用户取消「加密保存」：把已保存的密钥转回内存
      try {
        memoryKeys.set(id, unseal(sealed[id]));
      } catch {
        /* 无法解密则直接丢弃 */
      }
      delete sealed[id];
    }
    return;
  }
  if (key.length > 4096 || /\s/.test(key)) throw new DraftError('API Key 格式不正确');
  if (d.persistKey) {
    sealed[id] = seal(key); // 未配置 CREDENTIAL_SECRET 时抛错
    memoryKeys.delete(id);
  } else {
    memoryKeys.set(id, key);
    delete sealed[id];
  }
}

/** 向供应商查询模型列表并保存结果 */
export async function refreshModels(id: string): Promise<ProviderConfig | undefined> {
  const cfg = await getConfig(id);
  if (!cfg) return undefined;
  const key = await getApiKey(id);
  const r = !key && cfg.authMode !== 'none'
    ? { ok: false, models: [], message: '尚未设置 API Key' }
    : await listModels(cfg, key);
  const patch = { models: r.ok ? r.models : cfg.models, modelsError: r.ok ? null : r.message, modelsFetchedAt: now() };
  if (cfg.readonly) envModels.set(id, patch);
  else {
    const target = configs.find((c) => c.id === id);
    if (!target) return undefined;
    Object.assign(target, patch);
    await persist();
  }
  return getConfig(id);
}

export async function createConfig(d: ProviderDraft): Promise<ProviderConfig> {
  await load();
  const base = normalizeDraft(d);
  const id = randomUUID();
  applyKey(id, d);
  configs.push({
    ...base, id, models: [], manualModels: normalizeManual(d.manualModels), modelsFetchedAt: null, modelsError: null,
    keySource: 'none', createdAt: now(), updatedAt: now(),
  });
  await persist();
  return (await refreshModels(id))!;
}

export async function updateConfig(id: string, d: ProviderDraft): Promise<ProviderConfig> {
  await load();
  const idx = configs.findIndex((c) => c.id === id);
  if (idx < 0) throw new DraftError('该供应商不存在或为只读预置');
  const prev = configs[idx];
  const base = normalizeDraft({ ...d, name: d.name ?? prev.name });
  applyKey(id, d);
  const connectionChanged =
    base.protocol !== prev.protocol || base.baseUrl !== prev.baseUrl || base.authMode !== prev.authMode || !!d.apiKey?.trim() || !!d.clearKey;
  configs[idx] = {
    ...prev,
    ...base,
    manualModels: d.manualModels === undefined ? prev.manualModels : normalizeManual(d.manualModels),
    ...(connectionChanged ? { models: [], modelsError: null } : {}),
    updatedAt: now(),
  };
  await persist();
  return connectionChanged ? (await refreshModels(id))! : (await getConfig(id))!;
}

export async function duplicateConfig(id: string): Promise<ProviderConfig> {
  const src = await getConfig(id);
  if (!src) throw new DraftError('该供应商不存在');
  const copyId = randomUUID();
  // 服务端预置（环境变量）的密钥不随复制带出，避免被改写地址后外发
  if (src.keySource === 'memory') memoryKeys.set(copyId, memoryKeys.get(id)!);
  if (src.keySource === 'encrypted') sealed[copyId] = { ...sealed[id] };
  const { readonly: _r, keySource: _k, ...rest } = src;
  configs.push({
    ...rest, id: copyId, name: `${src.name.replace(/（服务端预置）$/, '')} 副本`.slice(0, 60),
    keySource: 'none', createdAt: now(), updatedAt: now(),
  });
  await persist();
  return (await getConfig(copyId))!;
}

export async function deleteConfig(id: string) {
  await load();
  const idx = configs.findIndex((c) => c.id === id);
  if (idx < 0) throw new DraftError('该供应商不存在或为只读预置');
  configs.splice(idx, 1);
  memoryKeys.delete(id);
  delete sealed[id];
  await persist();
}
