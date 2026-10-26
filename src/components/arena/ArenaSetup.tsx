import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { hostOf } from '../../../shared/endpoint.ts';
import {
  CUBE_SIZE_INFO, DEFAULT_LIMITS, DIFFICULTIES, MAX_SCRAMBLE_LENGTH, scrambleLevelName, type BrowserProvider, type ProviderConfig, type ReasoningEffort, type RunEntry,
  type RunLimits,
} from '../../../shared/types.ts';
import { api, type Meta } from '../../lib/api.ts';
import { EFFORT_TEXT } from '../../lib/format.ts';
import HeroCube from '../HeroCube.tsx';
import MiniCube from '../MiniCube.tsx';
import ModelAvatar from '../ModelAvatar.tsx';
import ProviderForm from '../ProviderForm.tsx';
import { loadProviders, PROVIDER_STORAGE_NOTICE, subscribeProviders } from '../../lib/providers.ts';

/** 每个参测模型的推理参数 */
interface ModelParams {
  thinking: boolean;
  effort: Exclude<ReasoningEffort, 'default'>;
  maxOutputTokens: string;
}

interface SavedSetup {
  picked: Record<string, ModelParams>;
  cubeSize: number;
  steps: number;
  limits: RunLimits;
}

const STORE_KEY = 'cube-arena-setup';
const SLIDER_MAX = 60;
const EFFORTS: ModelParams['effort'][] = ['low', 'medium', 'high'];
const DEFAULT_PARAMS: ModelParams = { thinking: false, effort: 'medium', maxOutputTokens: '' };
const PRESETS: { id: string; name: string; desc: string; patch: Partial<RunLimits> }[] = [
  { id: 'quick', name: '快速体验', desc: '2 分钟 · 20 次调用', patch: { maxDurationSec: 120, maxApiCalls: 20, concurrency: 2 } },
  { id: 'standard', name: '标准评测', desc: '10 分钟 · 60 次调用', patch: { maxDurationSec: 600, maxApiCalls: 60, concurrency: 4 } },
  { id: 'deep', name: '深度评测', desc: '30 分钟 · 180 次调用', patch: { maxDurationSec: 1800, maxApiCalls: 180, concurrency: 4 } },
];
const keyOf = (providerId: string, model: string) => `${providerId}\u0000${model}`;
const splitKey = (k: string) => k.split('\u0000') as [string, string];
const modelsOf = (c: ProviderConfig) => [...new Set([...c.models, ...c.manualModels])];
const usable = (c: BrowserProvider) => c.keySource !== 'none' || c.authMode === 'none';

function loadSaved(): Partial<SavedSetup> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function SectionHead({ no, title, desc, children }: { no: string; title: string; desc: string; children?: React.ReactNode }) {
  return (
    <header className="sec-head">
      <span className="sec-no">{no}</span>
      <div className="sec-title">
        <h2>{title}</h2>
        <p>{desc}</p>
      </div>
      {children && <div className="sec-actions">{children}</div>}
    </header>
  );
}

export default function ArenaSetup({ onStarted }: { onStarted(runId: string): void }) {
  const [params] = useSearchParams();
  const saved = useMemo(loadSaved, []);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [providers, setProviders] = useState<BrowserProvider[]>([]);
  const [providersReady, setProvidersReady] = useState(false);
  const [picked, setPicked] = useState<Record<string, ModelParams>>(saved.picked ?? {});
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [cubeSize, setCubeSize] = useState(() => {
    const n = Number(params.get('size'));
    return CUBE_SIZE_INFO.some((c) => c.n === n) ? n : saved.cubeSize ?? 3;
  });
  const [steps, setSteps] = useState(() => {
    const s = Number(params.get('steps'));
    return s >= 1 && s <= MAX_SCRAMBLE_LENGTH ? s : saved.steps ?? 20;
  });
  const [limits, setLimits] = useState<RunLimits>(() => ({ ...DEFAULT_LIMITS, ...(saved.limits ?? {}) }));
  const [preset, setPreset] = useState(() => {
    const savedLimits = saved.limits;
    const match = PRESETS.find((p) => p.patch.maxDurationSec === savedLimits?.maxDurationSec && p.patch.maxApiCalls === savedLimits?.maxApiCalls && p.patch.concurrency === savedLimits?.concurrency);
    return match?.id ?? 'standard';
  });
  const [tab, setTab] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const reload = () => loadProviders().then((savedProviders) => {
    setProviders(savedProviders);
    setProvidersReady(true);
  }).catch((e) => {
    setProviders([]);
    setProvidersReady(true);
    setError((e as Error).message);
  });
  useEffect(() => {
    api.meta().then((m) => {
      setMeta(m);
    }).catch((e) => setError(e.message));
    void reload();
    return subscribeProviders(() => { void reload(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 已失效（服务商删除 / 模型下线）的勾选自动移除
  const available = useMemo(() => {
    const out: { key: string; provider: ProviderConfig; model: string }[] = [];
    for (const p of providers) if (usable(p)) for (const m of modelsOf(p)) out.push({ key: keyOf(p.id, m), provider: p, model: m });
    return out;
  }, [providers]);
  useEffect(() => {
    if (!providersReady) return;
    setPicked((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => available.some((a) => a.key === k))));
  }, [available, providersReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickedKeys = Object.keys(picked);
  const activeTab = tab && picked[tab] ? tab : pickedKeys[0] ?? null;
  const q = query.trim().toLowerCase();
  const visible = available.filter((a) => (providerFilter === 'all' || a.provider.id === providerFilter) && (!q || a.model.toLowerCase().includes(q)));
  const sizeInfo = CUBE_SIZE_INFO.find((c) => c.n === cubeSize)!;

  const toggle = (key: string) =>
    setPicked(({ [key]: had, ...rest }) => (had ? rest : { ...rest, [key]: { ...DEFAULT_PARAMS } }));
  const setParam = (key: string, patch: Partial<ModelParams>) => setPicked((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const applyToAll = () => {
    if (!activeTab) return;
    const p = picked[activeTab];
    setPicked((s) => Object.fromEntries(Object.keys(s).map((k) => [k, { ...p }])));
    setNotice('已将当前参数应用到全部参测模型');
  };

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ picked, cubeSize, steps, limits } satisfies SavedSetup));
      setNotice('配置已保存在本浏览器');
    } catch {
      setError('浏览器存储不可用，无法保存配置');
    }
  };

  // 草稿自动保存在当前浏览器，返回竞技场或刷新页面时可恢复。
  useEffect(() => {
    if (!providersReady) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ picked, cubeSize, steps, limits } satisfies SavedSetup));
    } catch {
      /* 手动保存按钮会给出可见错误；自动保存失败不阻塞配置。 */
    }
  }, [picked, cubeSize, steps, limits, providersReady]);

  const launch = async () => {
    setError('');
    setStarting(true);
    const entries: RunEntry[] = Object.entries(picked).map(([k, p]) => {
      const [providerId, model] = splitKey(k);
      return {
        providerId,
        model,
        reasoningEffort: p.thinking ? p.effort : 'default',
        maxOutputTokens: p.maxOutputTokens.trim() ? Number(p.maxOutputTokens) : null,
      };
    });
    try {
      const currentProviders = await loadProviders();
      if (entries.some((e) => !currentProviders.some((p) => p.id === e.providerId))) throw new Error('供应商配置已变更或浏览器会话已结束，请重新选择模型');
      const selectedProviders = currentProviders
        .filter((p) => entries.some((e) => e.providerId === p.id))
        .map(({ apiKey, ...config }) => ({
          config: { ...config, models: entries.filter((e) => e.providerId === config.id).map((e) => e.model), manualModels: [] },
          apiKey,
        }));
      const { id } = await api.startRun({ entries, providers: selectedProviders, scrambleLength: steps, cubeSize, limits });
      onStarted(id);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  const start = () => {
    if (!pickedKeys.length) return;
    setConfirming(true);
  };

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 2400);
    return () => clearTimeout(t);
  }, [notice]);

  const sliderPct = (Math.min(steps, SLIDER_MAX) - 1) / (SLIDER_MAX - 1);

  return (
    <main className="page wide setup">
      <section className="setup-hero">
        <div className="sh-copy">
          <p className="eyebrow">RUBIK&apos;S CUBE AI TESTING</p>
          <h1>创建 AI 魔方测试</h1>
          <p className="sh-sub">接入你偏好的模型，配置挑战条件，在相同初始状态下对比不同模型的求解能力。</p>
          <Link to="/practice" className="sh-link">先亲手试试 → 自由练习</Link>
        </div>
        <div className="sh-visual" aria-hidden="true">
          <HeroCube />
        </div>
        <p className="sh-tagline">SAME PUZZLE<br />DIFFERENT MINDS<br />DEEPER INSIGHTS</p>
      </section>

      <div className="setup-grid">
        <div className="setup-main">
          {/* 01 模型服务商 */}
          <section className="glass sec">
            <SectionHead no="01" title="模型服务商" desc="添加 API Key，自动获取可用模型列表，支持多服务商同时使用。">
              <button className="btn soft sm" onClick={() => setAdding(true)} disabled={!meta}>＋ 添加自定义服务商</button>
              <Link to="/providers" className="icon-btn more" aria-label="管理服务商" title="管理服务商">···</Link>
            </SectionHead>
            <p className="field-hint">{PROVIDER_STORAGE_NOTICE}</p>
            <div className="prov-cards">
              {providers.map((p) => {
                const models = modelsOf(p);
                const ok = usable(p);
                const state = !ok ? '未连接' : p.modelsError && !models.length ? '获取失败' : '已连接';
                const on = providerFilter === p.id;
                return (
                  <button key={p.id} className={`prov-card${on ? ' on' : ''}`} onClick={() => setProviderFilter(on ? 'all' : p.id)} title={on ? '显示全部服务商的模型' : '只看该服务商的模型'}>
                    <span className="pc-top">
                      <ModelAvatar model={p.name} host={hostOf(p.baseUrl)} size={34} />
                      <span className={`pc-state ${state === '已连接' ? 'ok' : state === '获取失败' ? 'warn' : ''}`}>{state}</span>
                    </span>
                    <b className="ellipsis">{p.name}</b>
                    <span className="pc-url ellipsis">{p.baseUrl}</span>
                    <span className="pc-count">{models.length} 个模型 <Link to="/providers" onClick={(e) => e.stopPropagation()} aria-label="管理">›</Link></span>
                  </button>
                );
              })}
              {!providers.length && (
                <button className="prov-card add" onClick={() => setAdding(true)} disabled={!meta}>
                  <span className="add-plus">＋</span>
                  <b>添加第一个服务商</b>
                  <span className="pc-url">填写 API 地址与 Key 即可</span>
                </button>
              )}
            </div>
          </section>

          {/* 02 选择参测模型 */}
          <section className="glass sec">
            <SectionHead no="02" title="选择参测模型" desc="从已连接的服务商中选择模型，支持多选并单独设置参数。">
              <label className="search-box">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型名称…" />
              </label>
              <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} aria-label="服务商">
                <option value="all">全部服务商</option>
                {providers.filter(usable).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </SectionHead>
            <div className="model-cards">
              {visible.map(({ key, provider, model }) => {
                const on = key in picked;
                return (
                  <div key={key} className={`model-pick${on ? ' on' : ''}`}>
                    <label className="mp-main">
                      <input type="checkbox" checked={on} onChange={() => toggle(key)} />
                      <ModelAvatar model={model} host={hostOf(provider.baseUrl)} size={40} />
                      <span className="mp-text">
                        <b className="ellipsis" title={model}>{model}</b>
                        <small className="ellipsis">{provider.name}</small>
                      </span>
                    </label>
                    {on && (
                      <span className="mp-chips">
                        <em>{picked[key].thinking ? `推理 ${EFFORT_TEXT[picked[key].effort]}` : '默认推理'}</em>
                        {picked[key].maxOutputTokens && <em>输出 ≤ {picked[key].maxOutputTokens}</em>}
                      </span>
                    )}
                    <button className="mp-gear" disabled={!on} onClick={() => { setTab(key); document.getElementById('sec-params')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }} aria-label={`设置 ${model} 的推理参数`} title="推理参数">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
                    </button>
                  </div>
                );
              })}
              {!visible.length && (
                <div className="empty">
                  {available.length ? '没有匹配的模型' : <>还没有可用的模型，请先在上方<button className="link-btn" onClick={() => setAdding(true)}>添加服务商</button></>}
                </div>
              )}
            </div>
          </section>

          {/* 03 魔方挑战设置 */}
          <section className="glass sec">
            <SectionHead no="03" title="魔方挑战设置" desc="选择魔方类型与打乱强度，所有模型使用相同的初始状态。" />
            <div className="challenge">
              <div className="size-row" role="radiogroup" aria-label="魔方类型">
                {CUBE_SIZE_INFO.map((c) => (
                  <button key={c.n} role="radio" aria-checked={cubeSize === c.n} className={cubeSize === c.n ? 'on' : ''} onClick={() => setCubeSize(c.n)}>
                    <MiniCube n={c.n} size={38} />
                    <span><b>{c.name}</b><small>{c.level}</small></span>
                  </button>
                ))}
              </div>
              <div className="steps-box">
                <div className="steps-head">
                  <span>打乱强度（步数）</span>
                  <label className="steps-input">
                    <input
                      type="number"
                      min={1}
                      max={MAX_SCRAMBLE_LENGTH}
                      value={steps}
                      onChange={(e) => setSteps(Math.max(1, Math.min(MAX_SCRAMBLE_LENGTH, Math.round(+e.target.value) || 1)))}
                      aria-label="打乱步数"
                    />
                    <span>步</span>
                  </label>
                </div>
                <input
                  className="steps-range"
                  type="range"
                  min={1}
                  max={SLIDER_MAX}
                  value={Math.min(steps, SLIDER_MAX)}
                  onChange={(e) => setSteps(+e.target.value)}
                  aria-label="打乱强度"
                  aria-valuetext={`${steps} 步`}
                  style={{ '--fill': `${sliderPct * 100}%` } as CSSProperties}
                />
                <div className="steps-ticks">
                  {DIFFICULTIES.map((d) => (
                    <button
                      key={d.id}
                      className={steps === d.scrambleLength ? 'on' : ''}
                      style={{ left: `${((d.scrambleLength - 1) / (SLIDER_MAX - 1)) * 100}%` }}
                      onClick={() => setSteps(d.scrambleLength)}
                    >
                      {d.name}
                      <small>({d.scrambleLength} 步)</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* 04 推理参数设置 */}
          <section className="glass sec" id="sec-params">
          <SectionHead no="04" title="推理参数设置" desc="为每个模型单独设置推理参数。">
              {pickedKeys.length > 1 && <button className="btn soft sm" onClick={applyToAll}>⚙ 批量设置</button>}
            </SectionHead>
            {activeTab ? (
              <>
                <div className="param-tabs" role="tablist">
                  {pickedKeys.map((k) => (
                    <button key={k} role="tab" aria-selected={k === activeTab} className={k === activeTab ? 'on' : ''} onClick={() => setTab(k)}>
                      {splitKey(k)[1]}
                    </button>
                  ))}
                </div>
                <div className="param-row">
                  <div className={`field effort-field${picked[activeTab].thinking ? '' : ' muted'}`}>
                    <span>推理强度</span>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={1}
                      value={EFFORTS.indexOf(picked[activeTab].effort)}
                      disabled={!picked[activeTab].thinking}
                      onChange={(e) => setParam(activeTab, { effort: EFFORTS[+e.target.value] })}
                      aria-label="推理强度"
                      aria-valuetext={EFFORT_TEXT[picked[activeTab].effort]}
                      style={{ '--fill': `${(EFFORTS.indexOf(picked[activeTab].effort) / 2) * 100}%` } as CSSProperties}
                    />
                    <div className="effort-labels"><span>低</span><span>中</span><span>高</span></div>
                  </div>
                  <label className="field">
                    <span>最大输出 Token</span>
                    <input type="number" min={64} max={200000} value={picked[activeTab].maxOutputTokens} placeholder="供应商默认" onChange={(e) => setParam(activeTab, { maxOutputTokens: e.target.value })} />
                  </label>
                  <label className="toggle-field">
                    <span className="switch">
                      <input type="checkbox" role="switch" checked={picked[activeTab].thinking} onChange={(e) => setParam(activeTab, { thinking: e.target.checked })} />
                      <span className="switch-track" aria-hidden="true" />
                    </span>
                    <span>
                      <b>启用额外思考</b>
                      <small>按推理强度发送对应参数；关闭则交给供应商默认</small>
                    </span>
                  </label>
                </div>
              </>
            ) : (
              <p className="empty">先在 02 中选择参测模型</p>
            )}
          </section>

          {/* 05 运行限制 */}
          <section className="glass sec" id="sec-limits">
            <SectionHead no="05" title="运行限制" desc="先用预设快速验证，再按需展开自定义限制，避免意外消耗 API 配额。" />
            <div className="limit-presets" role="radiogroup" aria-label="运行限制预设">
              {PRESETS.map((p) => (
                <button key={p.id} role="radio" aria-checked={preset === p.id} className={preset === p.id ? 'on' : ''} onClick={() => { setPreset(p.id); setLimits((cur) => ({ ...cur, ...p.patch })); }}>
                  <b>{p.name}</b><small>{p.desc}</small>
                </button>
              ))}
            </div>
            <details className="advanced limits-advanced">
              <summary>自定义限制</summary>
              <div className="form-grid three">
                <label className="field"><span>最长运行（秒）</span><input type="number" min={10} max={7200} value={limits.maxDurationSec} onChange={(e) => { setPreset('custom'); setLimits({ ...limits, maxDurationSec: Math.max(10, Math.min(7200, Math.round(+e.target.value) || 10)) }); }} /></label>
                <label className="field"><span>每模型最大调用</span><input type="number" min={1} max={1000} value={limits.maxApiCalls} onChange={(e) => { setPreset('custom'); setLimits({ ...limits, maxApiCalls: Math.max(1, Math.min(1000, Math.round(+e.target.value) || 1)) }); }} /></label>
                <label className="field"><span>并发模型数</span><input type="number" min={1} max={64} value={limits.concurrency} onChange={(e) => { setPreset('custom'); setLimits({ ...limits, concurrency: Math.max(1, Math.min(64, Math.round(+e.target.value) || 1)) }); }} /></label>
              </div>
              <p className="field-hint">费用由供应商返回的用量决定；未返回金额时平台不会自行估算。达到调用或时间上限后会停止后续请求。</p>
            </details>
          </section>
        </div>

        {/* 测试摘要 */}
        <aside className="glass summary">
          <header className="sum-head">
            <h2>测试摘要</h2>
            <button className="btn soft sm" onClick={save}>▦ 保存配置</button>
          </header>
          <div className="sum-cube">
            <MiniCube n={cubeSize} size={112} />
            <div>
              <b>{sizeInfo.name} {sizeInfo.level}魔方</b>
              <small>统一打乱状态 · {scrambleLevelName(steps)} {steps} 步</small>
            </div>
          </div>
          <dl className="sum-rows">
            <dt>参测模型</dt><dd>{pickedKeys.length} 个</dd>
            <dt>测试模式</dt><dd>并行求解</dd>
            <dt>初始状态</dt><dd>统一打乱</dd>
            <dt>最长运行</dt><dd>{Math.round(limits.maxDurationSec / 60)} 分钟</dd>
            <dt>最大调用</dt><dd>{limits.maxApiCalls} 次 / 模型</dd>
          </dl>
          <div className="sum-models-head">
            <span>已选模型</span>
            <span className="num">{pickedKeys.length}</span>
          </div>
          <ul className="sum-models">
            {pickedKeys.map((k) => {
              const [pid, model] = splitKey(k);
              const prov = providers.find((p) => p.id === pid);
              const p = picked[k];
              return (
                <li key={k}>
                  <ModelAvatar model={model} host={prov ? hostOf(prov.baseUrl) : ''} size={30} />
                  <span className="sm-text">
                    <b className="ellipsis" title={model}>{model}</b>
                    <small className="ellipsis">{prov?.name}</small>
                  </span>
                  <em>{p.thinking ? `推理 ${EFFORT_TEXT[p.effort]}` : '默认'}</em>
                  <button className="chip-x" onClick={() => toggle(k)} aria-label={`移除 ${model}`}>×</button>
                </li>
              );
            })}
            {!pickedKeys.length && <li className="empty">尚未选择模型</li>}
          </ul>
          <button className="btn dark block start-btn" disabled={!pickedKeys.length || starting} onClick={start}>
            {starting ? '正在创建…' : <>开始测试 <span aria-hidden="true">→</span></>}
          </button>
          <p className="sum-note">系统将为每个模型创建独立的魔方实例，并行执行测试。供应商未返回费用时，平台不会估算实际成本。</p>
          {error && <p className="form-error">{error}</p>}
        </aside>
      </div>

      {notice && <div className="toast" role="status">{notice}</div>}
      {meta && adding && (
        <ProviderForm
          meta={meta}
          editing={null}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
      {confirming && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setConfirming(false)}>
          <div className="glass strong modal narrow" role="dialog" aria-modal="true" aria-labelledby="confirm-run-title">
            <header className="modal-head"><h2 id="confirm-run-title">确认并开始评测</h2><button className="icon-btn" onClick={() => setConfirming(false)} aria-label="关闭">×</button></header>
            <div className="modal-body">
              <p>本局将同时运行 <b>{pickedKeys.length}</b> 个模型，使用 {sizeInfo.name}、{steps} 步打乱。</p>
              <dl className="info-rows">
                <dt>最长运行</dt><dd>{Math.round(limits.maxDurationSec / 60)} 分钟</dd>
                <dt>最大调用</dt><dd>{limits.maxApiCalls} 次 / 模型</dd>
                <dt>并发数</dt><dd>{limits.concurrency}</dd>
              </dl>
              <p className="field-hint">模型只会收到统一的 canonical cube state，不会收到初始打乱公式或其他模型的动作。实际费用取决于供应商返回的计费信息。</p>
            </div>
            <footer className="modal-foot"><button className="btn ghost" onClick={() => setConfirming(false)}>返回修改</button><button className="btn primary" onClick={() => { setConfirming(false); void launch(); }} disabled={starting}>{starting ? '正在创建…' : '确认配置并开始评测'}</button></footer>
          </div>
        </div>
      )}
    </main>
  );
}
