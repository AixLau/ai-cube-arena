import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { scrambleLengthOf, type ContestantState, type RunRecord, type TraceItem } from '../../shared/types.ts';
import ComparisonTable from '../components/ComparisonTable.tsx';
import CubeViewer, { type CubeViewerHandle } from '../components/CubeViewer.tsx';
import HiddenFacesToggle from '../components/HiddenFacesToggle.tsx';
import { api } from '../lib/api.ts';
import { formatDate, formatDuration, STATUS_TEXT } from '../lib/format.ts';

type MoveItem = Extract<TraceItem, { type: 'move' }>;

/** 回放用魔方：根据当前回放时间决定显示到第几步；前进少量步数时播放动画，跳转时直接定位 */
function ReplayCube({ c, moves, time, scramble, size, showHiddenFaces }: { c: ContestantState; moves: MoveItem[]; time: number; scramble: string; size: number; showHiddenFaces: boolean }) {
  const viewer = useRef<CubeViewerHandle>(null);
  const shown = useRef(0);
  let k = 0;
  while (k < moves.length && moves[k].t <= time) k++;

  useEffect(() => {
    const diff = k - shown.current;
    if (diff === 0) return;
    if (diff > 0 && diff <= 3) for (let i = shown.current; i < k; i++) viewer.current?.addMove(moves[i].move);
    else viewer.current?.jumpTo(moves.slice(0, k).map((m) => m.move).join(' '));
    shown.current = k;
  }, [k, moves]);

  const finished = k === moves.length && time >= (moves[moves.length - 1]?.t ?? 0);
  return (
    <article className="glass contestant replay">
      <header className="ct-head">
        <div className="ct-title">
          <strong className="ellipsis mono">{c.info.model}</strong>
          <span className="ellipsis">{c.info.name}</span>
        </div>
        <span className={`badge ${finished ? c.status : 'running'}`}><span className="dot" />{finished ? STATUS_TEXT[c.status] : '回放中'}</span>
      </header>
      <div className="ct-stage">
        <CubeViewer ref={viewer} setupAlg={scramble} size={size} tempoScale={3} showHiddenFaces={showHiddenFaces} />
        <div className="ct-last"><span>第 {k} / {moves.length} 步</span><b className="mono">{moves[k - 1]?.move ?? '—'}</b></div>
      </div>
    </article>
  );
}

export default function RunDetailPage() {
  const { id = '' } = useParams();
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [showHiddenFaces, setShowHiddenFaces] = useState(false);
  const [traceOf, setTraceOf] = useState<string | null>(null);
  const [traceFilter, setTraceFilter] = useState<'all' | 'move' | 'call' | 'status' | 'log'>('all');

  useEffect(() => {
    api.run(id).then(setRecord).catch((e) => setError(e.message));
  }, [id]);

  const moves = useMemo(() => {
    const out: Record<string, MoveItem[]> = {};
    if (record) for (const c of record.contestants) out[c.info.id] = (record.traces[c.info.id] ?? []).filter((t): t is MoveItem => t.type === 'move');
    return out;
  }, [record]);
  const endT = useMemo(() => {
    if (!record) return 0;
    const traceTimes = Object.values(record.traces).flatMap((items) => items.map((item) => item.t));
    const durations = record.contestants.map((c) => c.stats.durationMs);
    const finished = record.finishedAt ? Date.parse(record.finishedAt) - Date.parse(record.createdAt) : 0;
    return Math.max(0, ...traceTimes, ...durations, finished);
  }, [record, moves]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setTime((t) => {
        const next = Math.min(endT, t + dt);
        if (next >= endT) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, endT]);

  if (error) return <main className="page"><p className="form-error">{error}</p></main>;
  if (!record) return <main className="page"><p className="hint-text">加载中…</p></main>;

  const n = record.contestants.length;
  const layout = n <= 1 ? 'n1' : n === 2 ? 'n2' : n <= 4 ? 'n34' : 'nmany';
  const trace = traceOf ? record.traces[traceOf] ?? [] : [];

  return (
    <main className="page wide">
      <div className="page-head row">
        <div>
          <h1>评测回放</h1>
          <p>
            {formatDate(record.createdAt)} · {record.cubeSize ?? 3}×{record.cubeSize ?? 3} · {scrambleLengthOf(record)} 步打乱 · {n} 个模型 ·
            打乱 <span className="mono">{record.scramble}</span>
          </p>
        </div>
        <div className="btn-row">
          <Link to="/reports" className="btn ghost">返回列表</Link>
          <a className="btn ghost" href={api.exportUrl(record.id)} download>导出 JSON</a>
        </div>
      </div>

      <section className="glass panel" style={{ marginBottom: 20 }}>
        <h2 className="panel-title">测试规则</h2>
        <div className="rule-chips">
          <span className="chip">最长运行：{Math.round(record.limits.maxDurationSec / 60)} 分钟</span>
          <span className="chip">最大调用：{record.limits.maxApiCalls} 次 / 模型</span>
          <span className="chip">并发：{record.limits.concurrency}</span>
          <span className="chip mono" title="初始状态（URFDLB 顺序 54 格）">初始状态 {record.initialState}</span>
        </div>
      </section>

      <div className="glass arena-bar">
        <button className="btn primary sm" onClick={() => { if (time >= endT) setTime(0); setPlaying(!playing); }} disabled={endT === 0}>
          {playing ? '暂停' : time >= endT && endT > 0 ? '重新播放' : '播放'}
        </button>
        <button className="btn ghost sm" onClick={() => { setPlaying(false); setTime((t) => Math.max(0, t - 1000)); }} disabled={endT === 0}>上一步</button>
        <button className="btn ghost sm" onClick={() => { setPlaying(false); setTime((t) => Math.min(endT, t + 1000)); }} disabled={endT === 0}>下一步</button>
        <button className="btn ghost sm" onClick={() => {
          const firstError = record.contestants.flatMap((c) => (record.traces[c.info.id] ?? []).filter((t) => (t.type === 'log' && t.level === 'error') || (t.type === 'status' && (t.status === 'failed' || t.status === 'error')) || (t.type === 'call' && t.tools.some((tool) => !tool.ok))).map((t) => t.t)).sort((a, b) => a - b)[0];
          if (firstError !== undefined) { setPlaying(false); setTime(firstError); }
        }}>跳到首个错误</button>
        <button className="btn ghost sm" onClick={() => { setPlaying(false); setTime(Math.max(0, ...Object.values(moves).flatMap((items) => items.map((item) => item.t)))); }} disabled={endT === 0}>最后一步</button>
        <input className="timeline" type="range" min={0} max={endT} step={10} value={time} onChange={(e) => { setPlaying(false); setTime(+e.target.value); }} aria-label="回放进度" />
        <span className="num">{formatDuration(time)} / {formatDuration(endT)}</span>
        <select value={speed} onChange={(e) => setSpeed(+e.target.value)} aria-label="回放速度">
          {[1, 2, 4, 8, 16].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <HiddenFacesToggle checked={showHiddenFaces} onChange={setShowHiddenFaces} />
      </div>

      <div className={`contestant-grid ${layout}`} style={{ marginBottom: 20 }}>
        {record.contestants.map((c) => (
          <ReplayCube key={c.info.id} c={c} moves={moves[c.info.id] ?? []} time={time} scramble={record.scramble} size={record.cubeSize ?? 3} showHiddenFaces={showHiddenFaces} />
        ))}
      </div>

      <section className="glass panel" style={{ marginBottom: 20 }}>
        <h2 className="panel-title">横向对比</h2>
        <ComparisonTable contestants={record.contestants} />
      </section>

      <section className="glass panel">
        <h2 className="panel-title">完整轨迹 <span className="hint">调用 → 动作 → 状态 → 错误</span></h2>
        <div className="tabs" style={{ marginBottom: 12 }}>
          {record.contestants.map((c) => (
            <button key={c.info.id} className={traceOf === c.info.id ? 'on' : ''} onClick={() => setTraceOf(traceOf === c.info.id ? null : c.info.id)}>
              {c.info.model}
            </button>
          ))}
        </div>
        {traceOf ? (
          <>
          <div className="btn-row trace-filters" style={{ marginBottom: 10 }}>
            {(['all', 'move', 'call', 'status', 'log'] as const).map((kind) => <button key={kind} className={traceFilter === kind ? 'btn soft sm' : 'btn ghost sm'} onClick={() => setTraceFilter(kind)}>{kind === 'all' ? '全部' : kind === 'move' ? '动作' : kind === 'call' ? '调用' : kind === 'status' ? '状态' : '错误与日志'}</button>)}
          </div>
          <div className="trace">
            {trace.filter((t) => traceFilter === 'all' || t.type === traceFilter).map((t, i) => (
              <div key={i} className={`trace-item ${t.type === 'log' ? t.level : t.type === 'status' ? 'status' : ''}`}>
                <span className="num t">{formatDuration(t.t)}</span>
                {t.type === 'move' && <span><b>动作</b> · <span className="chip">{t.move}</span> · 第 {t.index} 步</span>}
                {t.type === 'call' && (
                  <span>
                    <b>第 {t.n} 次调用</b> · {t.latencyMs} ms
                    {t.tools.map((x, j) => (
                      <span key={j} className={`chip${x.ok ? '' : ' bad'}`} title={x.error}>{x.ok ? x.moves.join(' ') || '（空）' : `拒绝：${x.error}`}</span>
                    ))}
                    {t.truncated && <span className="chip warn">输出被截断</span>}
                    {t.text && <span className="trace-text">{t.text}</span>}
                    {t.plan && <span className="trace-text">计划：{t.plan}</span>}
                    {t.reasoning && (
                      <details className="trace-think">
                        <summary>供应商返回的思考内容（不可直接比较）</summary>
                        <span className="trace-text">{t.reasoning}</span>
                      </details>
                    )}
                  </span>
                )}
                {t.type === 'status' && <span>状态：{STATUS_TEXT[t.status]}{t.reason ? ` · ${t.reason}` : ''}</span>}
                {t.type === 'log' && <span>{t.text}</span>}
              </div>
            ))}
          </div>
          </>
        ) : (
          <p className="hint-text">选择模型查看轨迹</p>
        )}
      </section>
    </main>
  );
}
