import { useEffect, useState } from 'react';
import { displayEndpoint, resolveEndpoint } from '../../shared/endpoint.ts';
import type { BrowserProvider, ConnectionTestResult, ProviderConfig } from '../../shared/types.ts';
import ProviderForm from '../components/ProviderForm.tsx';
import TestResultView from '../components/TestResultView.tsx';
import { api, type Meta } from '../lib/api.ts';
import { KEY_SOURCE_TEXT, PROTOCOL_SHORT } from '../lib/format.ts';
import { deleteProvider, duplicateProvider, loadProviders, PROVIDER_STORAGE_NOTICE, refreshProvider, subscribeProviders, testProvider, updateProvider } from '../lib/providers.ts';

const MODEL_PREVIEW = 24;

const allModels = (c: ProviderConfig) => [...new Set([...c.models, ...c.manualModels])];

function ProviderCard({ c, onChanged, onEdit, onError }: { c: BrowserProvider; onChanged(): void; onEdit(): void; onError(msg: string): void }) {
  const models = allModels(c);
  const [testModel, setTestModel] = useState(models[0] ?? '');
  const [test, setTest] = useState<ConnectionTestResult | 'pending' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [manual, setManual] = useState('');
  const hasKey = c.keySource !== 'none' || c.authMode === 'none';

  useEffect(() => {
    if (!models.includes(testModel)) setTestModel(models[0] ?? '');
  }, [models.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const refresh = () => {
    setRefreshing(true);
    void run(() => refreshProvider(c.id)).finally(() => setRefreshing(false));
  };

  const doTest = async () => {
    setTest('pending');
    try {
      setTest(await testProvider(c.id, testModel));
    } catch (e) {
      setTest(null);
      onError((e as Error).message);
    }
  };

  const updateManual = (list: string[]) =>
    run(() => updateProvider(c.id, { protocol: c.protocol, baseUrl: c.baseUrl, authMode: c.authMode, maxConcurrentRequests: c.maxConcurrentRequests, name: c.name, manualModels: list }));

  const remove = () => {
    if (window.confirm(`确定删除「${c.name}」？其密钥也会一并删除。`)) void run(() => deleteProvider(c.id));
  };

  const shown = expanded ? models : models.slice(0, MODEL_PREVIEW);
  const endpoint = resolveEndpoint(c.protocol, c.baseUrl, '{模型}');

  return (
    <article className="glass card provider-card">
      <h3>
        <span className="ellipsis">{c.name}</span>
        <span className={`tag ${!hasKey ? 'warn' : models.length ? 'ok' : 'warn'}`}>
          {!hasKey ? '缺少密钥' : models.length ? `${models.length} 个模型` : '无模型'}
        </span>
      </h3>
      <dl className="kv">
        <dt>协议</dt><dd>{PROTOCOL_SHORT[c.protocol]}</dd>
        <dt>地址</dt><dd className="mono ellipsis" title={displayEndpoint(endpoint)}>{displayEndpoint(endpoint)}</dd>
        <dt>密钥</dt><dd>{KEY_SOURCE_TEXT[c.keySource]}</dd>
      </dl>

      {models.length > 0 && (
        <div className="model-chips">
          {shown.map((m) => (
            <span key={m} className="chip" title={m}>
              {m}
              {c.manualModels.includes(m) && !c.models.includes(m) && (
                <button className="chip-x" aria-label={`移除 ${m}`} onClick={() => updateManual(c.manualModels.filter((x) => x !== m))}>×</button>
              )}
            </span>
          ))}
          {models.length > MODEL_PREVIEW && (
            <button className="link-btn" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : `全部 ${models.length} 个`}</button>
          )}
        </div>
      )}

      {c.modelsError && (
        <div className="models-error">
          <p className="form-warn" style={{ margin: 0 }}>{c.modelsError}</p>
          {hasKey && (
            <form
              className="manual-add"
              onSubmit={(e) => {
                e.preventDefault();
                const m = manual.trim();
                if (m) void updateManual([...c.manualModels, m]).then(() => setManual(''));
              }}
            >
              <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="手动添加模型" spellCheck={false} />
              <button className="btn ghost sm" type="submit" disabled={!manual.trim()}>添加</button>
            </form>
          )}
        </div>
      )}

      {test && test !== 'pending' && <TestResultView result={test} />}

      <div className="btn-row small">
        <button className="btn ghost" onClick={refresh} disabled={refreshing || !hasKey}>{refreshing ? '获取中…' : '刷新模型'}</button>
        {models.length > 0 && hasKey && (
          <span className="test-group">
            <select value={testModel} onChange={(e) => setTestModel(e.target.value)} aria-label="测试用模型">
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="btn ghost" onClick={doTest} disabled={test === 'pending' || !testModel}>{test === 'pending' ? '测试中…' : '测试'}</button>
          </span>
        )}
        <button className="btn ghost" onClick={onEdit}>编辑</button>
        <button className="btn ghost" onClick={() => run(() => duplicateProvider(c.id))}>复制</button>
        <button className="btn ghost danger-text" onClick={remove}>删除</button>
      </div>
    </article>
  );
}

export default function ProvidersPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [configs, setConfigs] = useState<BrowserProvider[]>([]);
  const [editing, setEditing] = useState<BrowserProvider | null | 'new'>(null);
  const [error, setError] = useState('');

  const reload = () => loadProviders().then(setConfigs).catch((e) => {
    setConfigs([]);
    setError((e as Error).message);
  });
  useEffect(() => {
    api.meta().then(setMeta).catch((e) => setError(e.message));
    void reload();
    return subscribeProviders(() => { void reload(); });
  }, []);

  return (
    <main className="page">
      <div className="page-head row">
        <h1>模型配置</h1>
        <button className="btn primary" onClick={() => setEditing('new')} disabled={!meta}>＋ 添加供应商</button>
      </div>
      <p className="field-hint">{PROVIDER_STORAGE_NOTICE}</p>
      {error && <p className="form-error">{error}</p>}

      <div className="cards">
        {configs.map((c) => (
          <ProviderCard
            key={c.id}
            c={c}
            onChanged={() => {
              setError('');
              void reload();
            }}
            onEdit={() => setEditing(c)}
            onError={setError}
          />
        ))}
        {!configs.length && (
          <button className="glass card add-card" onClick={() => setEditing('new')} disabled={!meta}>
            <span>＋</span>添加供应商
          </button>
        )}
      </div>

      {meta && editing && (
        <ProviderForm
          meta={meta}
          editing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </main>
  );
}
