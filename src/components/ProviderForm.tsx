import { useState } from 'react';
import { displayEndpoint, resolveEndpoint } from '../../shared/endpoint.ts';
import type { AuthMode, ProtocolId, ProviderConfig, ProviderDraft } from '../../shared/types.ts';
import { api, type Meta } from '../lib/api.ts';
import { KEY_SOURCE_TEXT } from '../lib/format.ts';

interface Props {
  meta: Meta;
  editing: ProviderConfig | null;
  onClose(): void;
  onSaved(cfg: ProviderConfig): void;
}

const AUTH_LABEL: Record<AuthMode, string> = {
  bearer: 'Authorization: Bearer',
  'x-api-key': 'x-api-key 请求头',
  'x-goog-api-key': 'x-goog-api-key 请求头',
  none: '不发送密钥',
};

/** 新增 / 编辑供应商：只需协议、API 地址与密钥，保存后自动获取模型列表 */
export default function ProviderForm({ meta, editing, onClose, onSaved }: Props) {
  const [protocol, setProtocol] = useState<ProtocolId>(editing?.protocol ?? 'openai-chat');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [persistKey, setPersistKey] = useState(editing?.keySource === 'encrypted');
  const [name, setName] = useState(editing?.name ?? '');
  const [authMode, setAuthMode] = useState<AuthMode>(editing?.authMode ?? 'bearer');
  const [maxConcurrent, setMaxConcurrent] = useState(editing?.maxConcurrentRequests?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const info = meta.protocols.find((p) => p.id === protocol)!;
  const endpoint = resolveEndpoint(protocol, baseUrl, '{模型}');
  let versionWarning = '';
  try {
    const path = new URL(endpoint).pathname;
    if ((protocol === 'openai-chat' || protocol === 'openai-responses') && !/\/v\d/.test(path)) {
      versionWarning = '地址中没有 /v1 等版本路径，若供应商要求请补上（系统不会自动追加）。';
    }
    if (/\/v1\/v1(\/|$)/.test(path)) versionWarning = '最终地址出现了重复的 /v1，请检查 API 地址。';
  } catch {
    /* 尚未填写完整 */
  }

  const changeProtocol = (p: ProtocolId) => {
    setProtocol(p);
    setAuthMode(meta.protocols.find((x) => x.id === p)!.defaultAuth);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    const draft: ProviderDraft = {
      name: name.trim() || undefined,
      protocol,
      baseUrl,
      authMode,
      maxConcurrentRequests: maxConcurrent.trim() === '' ? null : Number(maxConcurrent),
      apiKey: apiKey || undefined,
      persistKey,
    };
    try {
      const cfg = editing ? await api.updateProvider(editing.id, draft) : await api.createProvider(draft);
      setApiKey('');
      onSaved(cfg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass strong modal narrow" role="dialog" aria-modal="true" aria-label={editing ? '编辑供应商' : '添加供应商'}>
        <header className="modal-head">
          <h2>{editing ? '编辑供应商' : '添加供应商'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>接口协议</span>
            <select value={protocol} onChange={(e) => changeProtocol(e.target.value as ProtocolId)}>
              {meta.protocols.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>API 地址</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={info.baseUrlExample} inputMode="url" spellCheck={false} autoFocus={!editing} />
          </label>
          {baseUrl && (
            <div className="endpoint-preview">
              <span>请求地址</span>
              <code>{displayEndpoint(endpoint)}</code>
            </div>
          )}
          {versionWarning && <p className="form-warn">{versionWarning}</p>}
          <label className="field">
            <span>
              API Key
              {editing && editing.keySource !== 'none' && <em className="field-hint"> · {KEY_SOURCE_TEXT[editing.keySource]}，留空保持不变</em>}
            </span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" spellCheck={false} />
          </label>
          {meta.encryptionAvailable && (
            <label className="check" style={{ marginBottom: 12 }}>
              <input type="checkbox" checked={persistKey} onChange={(e) => setPersistKey(e.target.checked)} />
              在服务端加密保存密钥
            </label>
          )}

          <details className="advanced">
            <summary>高级</summary>
            <label className="field">
              <span>名称</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="默认使用域名" maxLength={60} />
            </label>
            <div className="form-grid">
              <label className="field">
                <span>认证方式</span>
                <select value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode)}>
                  {(Object.keys(AUTH_LABEL) as AuthMode[]).map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
                </select>
              </label>
              <label className="field">
                <span>最大并发请求数</span>
                <input type="number" min={1} max={64} value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} placeholder="不限" />
              </label>
            </div>
          </details>

          {error && <p className="form-error">{error}</p>}
        </div>
        <footer className="modal-foot">
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={save} disabled={busy || !baseUrl.trim()}>{busy ? '正在获取模型…' : '保存并获取模型'}</button>
        </footer>
      </div>
    </div>
  );
}
