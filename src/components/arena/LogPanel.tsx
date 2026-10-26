import { useEffect, useMemo, useRef, useState } from 'react';
import { TERMINAL_STATUSES } from '../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { formatCost, formatDuration, formatMs, formatTokens, STATUS_TEXT } from '../../lib/format.ts';
import type { LiveContestant } from '../../lib/useRunStream.ts';
import ComparisonTable from '../ComparisonTable.tsx';
import ModelAvatar from '../ModelAvatar.tsx';

type Tab = 'moves' | 'outputs' | 'compare' | 'metrics' | 'thinking';
const TABS: { id: Tab; name: string }[] = [
  { id: 'moves', name: '操作记录' },
  { id: 'outputs', name: '模型输出' },
  { id: 'compare', name: '状态对比' },
  { id: 'metrics', name: '关键指标' },
  { id: 'thinking', name: '思维过程' },
];

type Call = LiveContestant['calls'][number];

/** 转动属于哪一次 API 调用：调用记录在执行完工具后写入，取时间不早于该转动的第一次调用 */
function moveRows(c: LiveContestant) {
  let prev: Call | undefined;
  return c.moves.map((move, i) => {
    const t = c.moveTimes[i] ?? 0;
    const call = c.calls.find((x) => x.t >= t);
    const firstOfCall = !!call && call !== prev;
    prev = call;
    return { i, move, t, call, firstOfCall };
  });
}

export default function LogPanel({ runId, contestants, finished }: { runId: string; contestants: LiveContestant[]; finished: boolean }) {
  const [tab, setTab] = useState<Tab>('moves');
  const [sel, setSel] = useState<string>('all');
  const body = useRef<HTMLDivElement>(null);
  const shown = sel === 'all' ? contestants : contestants.filter((c) => c.state.info.id === sel);
  const multi = shown.length > 1;

  const rows = useMemo(() => {
    const all = shown.flatMap((c) => moveRows(c).map((r) => ({ ...r, c })));
    return all.sort((a, b) => a.t - b.t).slice(-200);
  }, [shown]);
  const requestRows = useMemo(() => shown.flatMap((c) => c.calls.map((call) => ({ c, call }))).sort((a, b) => a.call.t - b.call.t), [shown]);

  // 新记录出现时滚动到底部（只滚动面板内部）
  useEffect(() => {
    const el = body.current;
    if (el && (tab === 'moves' || tab === 'outputs' || tab === 'thinking')) el.scrollTop = el.scrollHeight;
  }, [rows.length, tab, shown.map((c) => c.calls.length + c.logs.length).join()]);

  return (
    <section className="glass log-panel">
      <header className="lp-head">
        <nav className="lp-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.name}</button>
          ))}
        </nav>
        <span style={{ flex: 1 }} />
        <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="筛选模型">
          <option value="all">全部模型</option>
          {contestants.map((c) => <option key={c.state.info.id} value={c.state.info.id}>{c.state.info.model}</option>)}
        </select>
        <a className="btn soft sm" href={api.exportUrl(runId)} download>⤓ 导出日志</a>
      </header>

      <div className="lp-grid">
        <ul className="lp-models">
          {contestants.map((c) => {
            const on = sel === c.state.info.id;
            return (
              <li key={c.state.info.id}>
                <button className={on ? 'on' : ''} onClick={() => setSel(on ? 'all' : c.state.info.id)}>
                  <ModelAvatar model={c.state.info.model} host={c.state.info.host} size={30} />
                  <span className="lm-text"><b className="ellipsis">{c.state.info.model}</b><small className="ellipsis">{c.state.info.name}</small></span>
                  <span className={`lm-status ${c.state.status}`}>{STATUS_TEXT[c.state.status]}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="lp-body" ref={body}>
          {tab === 'moves' && (
            <table className="lp-table">
              <thead>
                <tr>
                  <th>#</th>
                  {multi && <th>模型</th>}
                  <th>时间</th>
                  <th>旋转指令</th>
                  <th>模型输出（解析后）</th>
                  <th>API 调用</th>
                  <th className="r">输入 Token</th>
                  <th className="r">输出 Token</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.c.state.info.id}-${r.i}`}>
                    <td className="num">{r.i + 1}</td>
                    {multi && <td className="ellipsis cell-model">{r.c.state.info.model}</td>}
                    <td className="num">{formatDuration(r.t)}</td>
                    <td className="mono"><b>{r.move}</b></td>
                    <td className="cell-out ellipsis" title={r.call?.text}>{r.firstOfCall ? r.call?.text || '（仅调用工具）' : ''}</td>
                    <td>{r.firstOfCall ? `第 ${r.call!.n} 次` : '—'}</td>
                    <td className="r num">{r.firstOfCall ? formatTokens(r.call?.usage?.input ?? null) : '—'}</td>
                    <td className="r num">{r.firstOfCall ? formatTokens(r.call?.usage?.output ?? null) : '—'}</td>
                    <td><span className="st-ok">✓ 成功</span></td>
                  </tr>
                ))}
                {requestRows.map(({ c, call }) => (
                  <tr key={`request-${c.state.info.id}-${call.n}-${call.t}`} className={call.outcome === 'error' ? 'pending' : undefined}>
                    <td className="num">—</td>
                    {multi && <td className="ellipsis cell-model">{c.state.info.model}</td>}
                    <td className="num">{formatDuration(call.t)}</td>
                    <td className="mono">—</td>
                    <td className="cell-out ellipsis" title={call.error}>{call.outcome === 'error' ? `请求失败：${call.error ?? '未知错误'}` : '请求完成'} · 响应 {formatMs(call.latencyMs)}</td>
                    <td>第 {call.n} 次</td>
                    <td className="r num">{formatTokens(call.usage?.input ?? null)}</td>
                    <td className="r num">{formatTokens(call.usage?.output ?? null)}</td>
                    <td><span className={call.outcome === 'error' ? 'st-wait' : 'st-ok'}>{call.outcome === 'error' ? '⚠ 失败' : '✓ 成功'}</span></td>
                  </tr>
                ))}
                {!finished && shown.filter((c) => !TERMINAL_STATUSES.includes(c.state.status)).map((c) => (
                  <tr key={`pending-${c.state.info.id}`} className="pending">
                    <td className="num">{c.moves.length + 1}</td>
                    {multi && <td className="ellipsis cell-model">{c.state.info.model}</td>}
                    <td>—</td>
                    <td>—</td>
                    <td>{c.state.status === 'queued' ? '排队中…' : c.state.status === 'paused' ? '已暂停' : '规划中…'}</td>
                    <td>—</td>
                    <td className="r">—</td>
                    <td className="r">—</td>
                    <td><span className="st-wait">◷ 等待中</span></td>
                  </tr>
                ))}
                {!rows.length && finished && <tr><td colSpan={9} className="empty">没有转动记录</td></tr>}
              </tbody>
            </table>
          )}

          {tab === 'outputs' && (
            <div className="lp-feed">
              {shown.flatMap((c) => c.calls.map((call) => ({ c, call }))).sort((a, b) => a.call.t - b.call.t).map(({ c, call }) => (
                <article key={`${c.state.info.id}-${call.n}`} className="feed-item">
                  <header>
                    <b>{multi ? `${c.state.info.model} · ` : ''}第 {call.n} 次调用</b>
                    <span className="num">{formatDuration(call.t)} · 响应 {formatMs(call.latencyMs)}{call.outcome === 'error' ? ' · 失败' : ''}{call.truncated ? ' · 输出被截断' : ''}{call.usage ? ` · 输入 ${formatTokens(call.usage.input)} / 输出 ${formatTokens(call.usage.output)}` : ''}</span>
                  </header>
                  {call.error && <p className="form-error">{call.error}</p>}
                  {call.text && <p>{call.text}</p>}
                  {call.plan && <p><b>计划：</b>{call.plan}</p>}
                  <div className="feed-tools">
                    {call.tools.length ? call.tools.map((t, i) => (
                      <span key={i} className={`chip${t.ok ? '' : ' bad'}`} title={t.error}>{t.ok ? `rotate_cube(${t.moves.join(' ')})` : `已拒绝：${t.error}`}</span>
                    )) : <span className="chip bad">未调用工具</span>}
                  </div>
                </article>
              ))}
              {shown.every((c) => !c.calls.length) && <p className="empty">还没有模型输出</p>}
            </div>
          )}

          {tab === 'compare' && <ComparisonTable contestants={shown.map((c) => c.state)} />}

          {tab === 'metrics' && (
            <div className="metric-cards">
              {shown.map((c) => {
                const s = c.state.stats;
                return (
                  <article key={c.state.info.id} className="metric-card">
                    <header><ModelAvatar model={c.state.info.model} host={c.state.info.host} size={26} /><b className="ellipsis">{c.state.info.model}</b></header>
                    <dl>
                      <dt>面转 / QTM</dt><dd>{s.moves} / {s.qtm}</dd>
                      <dt>API 调用</dt><dd>{s.apiCalls}{s.throttledCalls ? `（限流 ${s.throttledCalls}）` : ''}</dd>
                      <dt>无效调用</dt><dd>{s.invalidToolCalls}</dd>
                      <dt>输入 Token</dt><dd>{formatTokens(s.inputTokens)}</dd>
                      <dt>输出 Token</dt><dd>{formatTokens(s.outputTokens)}</dd>
                      <dt>推理 Token</dt><dd>{s.reasoningTokens === null ? '未提供' : formatTokens(s.reasoningTokens)}</dd>
                      <dt>平均响应</dt><dd>{s.apiCalls ? formatMs(Math.round(s.apiLatencyMs / s.apiCalls)) : '—'}</dd>
                      <dt>整局耗时</dt><dd>{formatDuration(s.durationMs)}</dd>
                      <dt>API 费用</dt><dd>{formatCost(s.cost)}</dd>
                      <dt>已归位贴纸</dt><dd>{s.correctStickers}</dd>
                    </dl>
                  </article>
                );
              })}
            </div>
          )}

          {tab === 'thinking' && (
            <div className="lp-feed">
              {shown
                .flatMap((c) => [
                  ...c.calls.flatMap((x) => [
                    ...(x.reasoning ? [{ c, t: x.t, kind: 'think' as const, text: x.reasoning }] : []),
                    ...(x.text ? [{ c, t: x.t, kind: 'say' as const, text: x.text }] : []),
                    ...(x.plan ? [{ c, t: x.t, kind: 'plan' as const, text: x.plan }] : []),
                  ]),
                  ...c.logs.map((l) => ({ c, t: l.t, kind: l.level, text: l.text })),
                ])
                .sort((a, b) => a.t - b.t)
                .map((e, i) => (
                  <div key={i} className={`think-item ${e.kind}`}>
                    <span className="num t">{formatDuration(e.t)}</span>
                    <span>
                      {multi && <b>{e.c.state.info.model}：</b>}
                      {e.kind === 'think' && <em className="think-tag">思考</em>}
                      {e.kind === 'say' && <em className="think-tag">回复</em>}
                      {e.kind === 'plan' && <em className="think-tag">计划</em>}
                      {e.text}
                    </span>
                  </div>
                ))}
              {shown.every((c) => !c.calls.some((x) => x.text || x.reasoning || x.plan) && !c.logs.length) && (
                <p className="empty">模型还没有输出思考内容（部分供应商不返回思考过程，或模型只调用工具、不输出文字）</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
