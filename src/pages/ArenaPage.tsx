import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CUBE_SIZE_INFO, DIFFICULTIES, TERMINAL_STATUSES, type ProviderConfig, type ReasoningEffort, type RunEntry, type RunLimits } from '../../shared/types.ts';
import ComparisonTable from '../components/ComparisonTable.tsx';
import ContestantCard from '../components/ContestantCard.tsx';
import HiddenFacesToggle from '../components/HiddenFacesToggle.tsx';
import { api, type Meta } from '../lib/api.ts';
import { useRunStream } from '../lib/useRunStream.ts';

const usable = (c: ProviderConfig) => c.keySource !== 'none' || c.authMode === 'none';
const modelsOf = (c: ProviderConfig) => [...new Set([...c.models, ...c.manualModels])];
const pickKey = (providerId: string, model: string) => `${providerId}\u0000${model}`;

const LIMIT_FIELDS: { key: keyof RunLimits; label: string; min: number; max: number }[] = [
  { key: 'maxApiCalls', label: '最大 API 调用', min: 1, max: 1000 },
  { key: 'maxDurationSec', label: '最大运行时间（秒）', min: 10, max: 7200 },
  { key: 'maxMovesPerCall', label: '单次调用最多步数', min: 1, max: 50 },
  { key: 'concurrency', label: '同时运行模型数', min: 1, max: 64 },
];

export default function ArenaPage() {
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const view = useRunStream(runId);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  /** 已勾选的模型 → 推理强度 */
  const [picked, setPicked] = useState<Record<string, ReasoningEffort>>({});
  const [filter, setFilter] = useState('');
  // 首页第 2 步选择的阶数与打乱程度通过查询参数带入
  const [difficulty, setDifficulty] = useState(() => {
    const d = params.get('difficulty');
    return DIFFICULTIES.some((x) => x.id === d) ? d! : 'easy';
  });
  const [cubeSize, setCubeSize] = useState(() => {
    const n = Number(params.get('size'));
    return CUBE_SIZE_INFO.some((c) => c.n === n) ? n : 3;
  });
  const [limits, setLimits] = useState<RunLimits | null>(null);
  const [tempo, setTempo] = useState(1.5);
  const [showHiddenFaces, setShowHiddenFaces] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.meta().then((m) => {
      setMeta(m);
      setLimits(m.defaultLimits);
    }).catch((e) => setError(e.message));
    api.providers().then(setProviders).catch((e) => setError(e.message));
  }, []);

  const contestants = view.order.map((id) => view.cs[id]).filter(Boolean);
  const live = !!runId && !view.finished && view.connection !== 'lost';
  const counts = useMemo(() => {
    const c = { running: 0, queued: 0, done: 0, solved: 0 };
    for (const x of contestants) {
      if (x.state.status === 'running' || x.state.status === 'paused') c.running++;
      else if (x.state.status === 'queued') c.queued++;
      if (TERMINAL_STATUSES.includes(x.state.status)) c.done++;
      if (x.state.status === 'solved') c.solved++;
    }
    return c;
  }, [contestants]);

  const ready = providers.filter((p) => usable(p) && modelsOf(p).length);
  const pickedCount = Object.keys(picked).length;
  const efforts = meta?.reasoningEfforts ?? [];
  const q = filter.trim().toLowerCase();

  const toggle = (key: string) =>
    setPicked(({ [key]: had, ...rest }) => (had ? rest : { ...rest, [key]: 'default' }));

  const setAllEfforts = (effort: ReasoningEffort) =>
    setPicked((p) => Object.fromEntries(Object.keys(p).map((k) => [k, effort])));

  const start = async () => {
    if (!limits) return;
    setError('');
    setStarting(true);
    const entries: RunEntry[] = Object.entries(picked).map(([k, reasoningEffort]) => {
      const [providerId, model] = k.split('\u0000');
      return { providerId, model, reasoningEffort };
    });
    try {
      const { id } = await api.startRun({ entries, difficulty, cubeSize, limits });
      setFocused(null);
      setParams({ run: id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const action = async (cid: string, a: 'pause' | 'resume' | 'stop') => {
    if (!runId) return;
    try {
      await api.contestantAction(runId, cid, a);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const n = contestants.length;
  const layout = n <= 1 ? 'n1' : n === 2 ? 'n2' : n <= 4 ? 'n34' : 'nmany';
  const focusedC = focused ? view.cs[focused] : null;

  return (
    <main className="page wide">
      <div className={`arena-multi${view.run ? ' has-run' : ''}`}>
        <aside className="stack arena-side">
          <section className="glass panel">
            <h2 className="panel-title">
              选择模型 <span className="hint">已选 {pickedCount}</span>
            </h2>
            {ready.length === 0 ? (
              <div className="empty">
                还没有可用的模型，<Link to="/providers">去添加供应商</Link>
              </div>
            ) : (
              <>
                <input className="model-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="搜索模型" disabled={live} />
                <div className="picker">
                  {ready.map((p) => {
                    const models = modelsOf(p).filter((m) => !q || m.toLowerCase().includes(q));
                    if (!models.length) return null;
                    return (
                      <div key={p.id} className="picker-group">
                        <div className="picker-provider ellipsis" title={p.name}>{p.name}</div>
                        {models.map((m) => {
                          const key = pickKey(p.id, m);
                          const on = key in picked;
                          return (
                            <div key={m} className={`picker-row${on ? ' sel' : ''}`}>
                              <label className="ellipsis" title={m}>
                                <input type="checkbox" checked={on} disabled={live} onChange={() => toggle(key)} />
                                <span className="mono">{m}</span>
                              </label>
                              {on && (
                                <select
                                  value={picked[key]}
                                  disabled={live}
                                  onChange={(e) => setPicked((s) => ({ ...s, [key]: e.target.value as ReasoningEffort }))}
                                  aria-label={`${m} 推理强度`}
                                  title="推理强度"
                                >
                                  {efforts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                                </select>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          <section className="glass panel">
            <div className="field">
              <span>魔方阶数</span>
              <div className="size-seg" role="radiogroup" aria-label="魔方阶数">
                {meta?.cubeSizes.map((c) => (
                  <button
                    key={c.n}
                    type="button"
                    role="radio"
                    aria-checked={cubeSize === c.n}
                    className={cubeSize === c.n ? 'on' : ''}
                    disabled={live}
                    onClick={() => setCubeSize(c.n)}
                  >
                    <b>{c.name}</b>
                    <small>{c.level}</small>
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>打乱程度</span>
              <select value={difficulty} disabled={live} onChange={(e) => setDifficulty(e.target.value)}>
                {meta?.difficulties.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>推理强度（应用到全部已选模型）</span>
              <select value="" disabled={live || !pickedCount} onChange={(e) => e.target.value && setAllEfforts(e.target.value as ReasoningEffort)}>
                <option value="">逐个设置</option>
                {efforts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            {limits && (
              <details className="advanced">
                <summary>高级设置</summary>
                <div className="limit-grid">
                  {LIMIT_FIELDS.map((f) => (
                    <label key={f.key} className="field">
                      <span>{f.label}</span>
                      <input
                        type="number"
                        min={f.min}
                        max={f.max}
                        value={limits[f.key]}
                        disabled={live}
                        onChange={(e) => setLimits({ ...limits, [f.key]: Number(e.target.value) })}
                      />
                    </label>
                  ))}
                </div>
              </details>
            )}
            {live ? (
              <button className="btn danger block" onClick={() => runId && api.stopRun(runId).catch((e) => setError(e.message))}>终止全部</button>
            ) : (
              <button className="btn primary block" disabled={!pickedCount || starting || !limits} onClick={start}>
                {starting ? '创建中…' : `开始评测（${pickedCount}）`}
              </button>
            )}
            {error && <p className="form-error">{error}</p>}
          </section>
        </aside>

        <section className="arena-main">
          <div className="glass arena-bar">
            {view.run && (
              <>
                <span className={`badge ${view.finished ? 'solved' : 'running'}`}>
                  <span className="dot" />
                  {view.finished ? '评测结束' : view.connection === 'lost' ? '连接中断' : '评测进行中'}
                </span>
                <span className="badge">{view.run.cubeSize ?? 3}×{view.run.cubeSize ?? 3}</span>
                <span className="badge">复原 {counts.solved}/{n}</span>
                <span className="badge">运行 {counts.running} · 排队 {counts.queued} · 结束 {counts.done}</span>
                <span className="scramble-inline" title="仅观众可见，不会提供给模型"><b>打乱</b><span className="mono">{view.run.scramble}</span></span>
              </>
            )}
            <span style={{ flex: 1 }} />
            <label className="tempo">
              动画 {tempo.toFixed(1)}×
              <input type="range" min={0.5} max={5} step={0.5} value={tempo} onChange={(e) => setTempo(+e.target.value)} />
            </label>
            <HiddenFacesToggle checked={showHiddenFaces} onChange={setShowHiddenFaces} />
          </div>

          {view.connection === 'lost' && <p className="form-error">实时连接已断开，评测仍在服务端继续，刷新页面可重新连接。</p>}

          {focusedC && view.run && (
            <div className="focus-wrap">
              <ContestantCard
                key={`focus-${focusedC.state.info.id}`}
                c={focusedC}
                scramble={view.run.scramble}
                cubeSize={view.run.cubeSize ?? 3}
                tempo={tempo}
                showHiddenFaces={showHiddenFaces}
                focused
                controllable={live}
                onFocus={() => setFocused(null)}
                onAction={(a) => action(focusedC.state.info.id, a)}
              />
            </div>
          )}

          {view.run && (
            <div className={`contestant-grid ${layout}`}>
              {contestants.map((c) => (
                <ContestantCard
                  key={c.state.info.id}
                  c={c}
                  scramble={view.run!.scramble}
                  cubeSize={view.run!.cubeSize ?? 3}
                  tempo={tempo}
                  showHiddenFaces={showHiddenFaces}
                  focused={false}
                  controllable={live}
                  onFocus={() => setFocused(focused === c.state.info.id ? null : c.state.info.id)}
                  onAction={(a) => action(c.state.info.id, a)}
                />
              ))}
            </div>
          )}

          {view.run && view.finished && (
            <section className="glass panel">
              <h2 className="panel-title">
                横向对比 <span className="hint"><Link to={`/history/${view.run.id}`}>回放 →</Link></span>
              </h2>
              <ComparisonTable contestants={contestants.map((c) => c.state)} />
            </section>
          )}
        </section>
      </div>
    </main>
  );
}
