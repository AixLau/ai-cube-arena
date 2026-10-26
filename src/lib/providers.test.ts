import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderDraft } from '../../shared/types.ts';
import { api } from './api.ts';
import {
  createProvider, deleteProvider, duplicateProvider, loadProviders, refreshProvider, subscribeProviders,
  testProvider, updateProvider,
} from './providers.ts';

const STORE_KEY = 'cube-arena-providers';
const COOKIE_NAME = 'cube_arena_browser_session';
const values = new Map<string, string>();
const cookies = new Map<string, string>();
const events = new EventTarget();
let cookieWrites: string[];
let blockCookies: boolean;
let blockStorage: boolean;
let modelsRequests: { config: unknown; apiKey: string }[];
let queue: Promise<unknown> = Promise.resolve();
const storage = {
  getItem: (key: string) => {
    if (blockStorage) throw new Error('Storage blocked');
    return values.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    if (blockStorage) throw new Error('Storage blocked');
    values.set(key, value);
  },
  removeItem: (key: string) => {
    if (blockStorage) throw new Error('Storage blocked');
    values.delete(key);
  },
};
const locks = {
  request: (_name: string, callback: () => unknown) => {
    const result = queue.then(callback);
    queue = result.catch(() => {});
    return result;
  },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
  set cookie(value: string) {
    cookieWrites.push(value);
    if (blockCookies) return;
    const [name, content] = value.split(';')[0].split('=');
    cookies.set(name, content);
  },
} });
Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'https:' } });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: events });

const draft = (over: Partial<ProviderDraft> = {}): ProviderDraft => ({
  name: 'test', protocol: 'openai-chat', baseUrl: 'https://models.example.com/v1', apiKey: 'test-browser-secret',
  ...over,
});

beforeEach(() => {
  values.clear();
  cookies.clear();
  queue = Promise.resolve();
  cookieWrites = [];
  blockCookies = false;
  blockStorage = false;
  modelsRequests = [];
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  api.refreshModels = async (config, apiKey) => {
    modelsRequests.push({ config, apiKey });
    return {
      ...config, name: config.name || 'models.example.com', models: ['model-a', 'model-b'],
      modelsError: null, modelsFetchedAt: new Date().toISOString(), keySource: apiKey ? 'browser' : 'none',
    };
  };
});

test('浏览器会话：刷新、重开标签页和共享标签页保留；Cookie 不携带配置或密钥且不设置持久有效期', async () => {
  const provider = await createProvider(draft());
  assert.deepEqual(await loadProviders(), [provider]);
  // No tab-local storage or in-memory cache participates in loading a record.
  const otherTab = await loadProviders();
  assert.deepEqual(otherTab, [provider]);
  assert.equal(cookieWrites.length, 1);
  assert.match(cookieWrites[0], /Path=\/; SameSite=Strict; Secure$/);
  assert.doesNotMatch(cookieWrites[0], /Expires|Max-Age|test-browser-secret|example\.com/i);
  assert.deepEqual(Object.keys(modelsRequests[0].config as object).includes('apiKey'), false);
  assert.equal(modelsRequests[0].apiKey, 'test-browser-secret');
});

test('新浏览器会话清理旧配置；浏览器恢复会话 Cookie 时允许恢复配置', async () => {
  const provider = await createProvider(draft());
  const restoredCookie = cookies.get(COOKIE_NAME)!;
  cookies.set(COOKIE_NAME, restoredCookie);
  assert.deepEqual(await loadProviders(), [provider]);
  cookies.clear();
  assert.deepEqual(await loadProviders(), []);
  assert.equal(values.has(STORE_KEY), false);
  assert.notEqual(cookies.get(COOKIE_NAME), restoredCookie);
});

test('会话标识不匹配的旧配置不能被新标签页读取', async () => {
  await createProvider(draft());
  const stale = values.get(STORE_KEY)!;
  cookies.clear();
  await loadProviders();
  values.set(STORE_KEY, stale);
  assert.deepEqual(await loadProviders(), []);
  assert.equal(values.has(STORE_KEY), false);
});

test('编辑留空保留密钥，复制、刷新、测试和删除使用同一浏览器存储', async () => {
  const provider = await createProvider(draft());
  const edited = await updateProvider(provider.id, draft({ name: 'edited', apiKey: undefined, manualModels: ['manual'] }));
  assert.equal(edited.apiKey, provider.apiKey);
  const copy = await duplicateProvider(edited.id);
  assert.notEqual(copy.id, edited.id);
  assert.equal(copy.apiKey, edited.apiKey);
  assert.deepEqual(copy.manualModels, ['manual']);
  await refreshProvider(copy.id);
  let tested = false;
  api.testProvider = async (config, apiKey, model) => {
    assert.equal(config.id, copy.id);
    assert.equal(apiKey, copy.apiKey);
    assert.equal(model, 'model-a');
    assert.ok(!('apiKey' in config));
    tested = true;
    return {} as Awaited<ReturnType<typeof api.testProvider>>;
  };
  await testProvider(copy.id, 'model-a');
  assert.equal(tested, true);
  await deleteProvider(edited.id);
  assert.deepEqual((await loadProviders()).map((p) => p.id), [copy.id]);
  await deleteProvider(copy.id);
  assert.deepEqual(await loadProviders(), []);
  assert.ok(!values.get(STORE_KEY)!.includes(provider.apiKey));
});

test('多个标签页并行添加和复制不会丢失彼此记录', async () => {
  await Promise.all([createProvider(draft({ name: 'a' })), createProvider(draft({ name: 'b' }))]);
  const providers = await loadProviders();
  assert.deepEqual(providers.map((p) => p.name).sort(), ['a', 'b']);
  await Promise.all(providers.map((p) => duplicateProvider(p.id)));
  assert.equal((await loadProviders()).length, 4);
});

test('更换连接不沿用旧模型，更新密钥后请求使用新密钥', async () => {
  const provider = await createProvider(draft());
  await updateProvider(provider.id, draft({ baseUrl: 'https://new.example.com/v1', apiKey: 'new-test-key' }));
  const request = modelsRequests.at(-1)!;
  assert.deepEqual((request.config as { models: string[] }).models, []);
  assert.equal(request.apiKey, 'new-test-key');
  assert.equal((await loadProviders())[0].apiKey, 'new-test-key');
});

test('上游请求失败时原配置不变，新增配置也不伪装保存成功', async () => {
  const provider = await createProvider(draft());
  api.refreshModels = async () => { throw new Error('Model request failed'); };
  await assert.rejects(updateProvider(provider.id, draft({ apiKey: 'replacement-key' })), /Model request failed/);
  await assert.rejects(createProvider(draft({ name: 'failed' })), /Model request failed/);
  assert.deepEqual(await loadProviders(), [provider]);
});

function deferredModels() {
  let finish!: () => void;
  api.refreshModels = (config) => new Promise((resolve) => {
    finish = () => resolve(config);
  });
  return { finish: () => finish() };
}

test('异步刷新不能复活已在其他标签页删除的配置', async () => {
  const provider = await createProvider(draft());
  const pending = deferredModels();
  const refreshing = refreshProvider(provider.id);
  await new Promise((resolve) => setImmediate(resolve));
  await deleteProvider(provider.id);
  pending.finish();
  await assert.rejects(refreshing, /不存在/);
  assert.deepEqual(await loadProviders(), []);
});

test('异步请求不能覆盖其他标签页编辑，也不能把旧密钥带入新会话', async () => {
  const provider = await createProvider(draft());
  const pending = deferredModels();
  const updating = updateProvider(provider.id, draft({ name: 'stale-edit' }));
  await new Promise((resolve) => setImmediate(resolve));
  const saved = JSON.parse(values.get(STORE_KEY)!);
  saved.providers[0].name = 'new-edit';
  values.set(STORE_KEY, JSON.stringify(saved));
  pending.finish();
  await assert.rejects(updating, /其他页面修改/);
  assert.equal((await loadProviders())[0].name, 'new-edit');

  const expired = deferredModels();
  const refreshing = refreshProvider(provider.id);
  await new Promise((resolve) => setImmediate(resolve));
  cookies.clear();
  expired.finish();
  await assert.rejects(refreshing, /会话已结束/);
  assert.deepEqual(await loadProviders(), []);
});

test('Cookie、存储或安全上下文不可用以及配置损坏时明确报错，不伪装保存成功', async () => {
  blockCookies = true;
  await assert.rejects(createProvider(draft()), /Cookie/);
  assert.equal(modelsRequests.length, 0);
  blockCookies = false;
  blockStorage = true;
  await assert.rejects(loadProviders(), /Storage blocked/);
  blockStorage = false;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  await assert.rejects(loadProviders(), /HTTPS/);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  await loadProviders();
  values.set(STORE_KEY, '{broken');
  await assert.rejects(loadProviders(), /损坏/);
});

test('存储事件、返回标签页和页面恢复触发同步；卸载监听后不再触发', async () => {
  let count = 0;
  const unsubscribe = subscribeProviders(() => count++);
  const changed = new Event('storage');
  Object.assign(changed, { storageArea: storage, key: STORE_KEY });
  events.dispatchEvent(changed);
  events.dispatchEvent(new Event('focus'));
  events.dispatchEvent(new Event('pageshow'));
  assert.equal(count, 3);
  unsubscribe();
  events.dispatchEvent(changed);
  events.dispatchEvent(new Event('focus'));
  assert.equal(count, 3);
});
