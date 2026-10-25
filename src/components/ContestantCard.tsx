import { useEffect, useRef, useState } from 'react';
import { TERMINAL_STATUSES } from '../../shared/types.ts';
import { EFFORT_TEXT, formatCost, formatDuration, formatMs, formatTokens, STATUS_TEXT, usageNote } from '../lib/format.ts';
import type { LiveContestant } from '../lib/useRunStream.ts';
import CubeViewer, { type CubeViewerHandle } from './CubeViewer.tsx';

interface Props {
  c: LiveContestant;
  scramble: string;
  cubeSize: number;
  tempo: number;
  showHiddenFaces: boolean;
  focused: boolean;
  controllable: boolean;
  onFocus(): void;
  onAction(action: 'pause' | 'resume' | 'stop'): void;
}

/** 积压超过该步数时直接跳到最新状态，不再逐步播放（例如中途打开页面） */
const CATCH_UP_THRESHOLD = 8;

export default function ContestantCard({ c, scramble, cubeSize, tempo, showHiddenFaces, focused, controllable, onFocus, onAction }: Props) {
  const viewer = useRef<CubeViewerHandle>(null);
  const applied = useRef(0);
  const historyBox = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  const { info, status, failReason, stats } = c.state;
  const running = status === 'running';

  // 每个模型的魔方只接收自己的转动事件，互不影响
  useEffect(() => {
    const pending = c.moves.length - applied.current;
    if (pending <= 0) return;
    if (pending > CATCH_UP_THRESHOLD) viewer.current?.jumpTo(c.moves.join(' '));
    else for (let i = applied.current; i < c.moves.length; i++) viewer.current?.addMove(c.moves[i]);
    applied.current = c.moves.length;
  }, [c.moves]);

  // 只滚动历史区域本身，不能用 scrollIntoView（会连带滚动整个页面）
  useEffect(() => {
    const el = historyBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [c.moves.length]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [running]);

  const duration = stats.durationMs + (running ? Math.max(0, now - c.statsAt) : 0);
  const lastCall = c.calls[c.calls.length - 1];
  const lastLog = c.logs[c.logs.length - 1];
  const terminal = TERMINAL_STATUSES.includes(status);
  const costHint = stats.cost === null ? '供应商未返回计费' : '供应商计费';
  const effort = info.reasoningEffort ?? 'default';
  const total = 6 * cubeSize * cubeSize;

  return (
    <article className={`glass contestant${focused ? ' focused' : ''} st-${status}`}>
      <header className="ct-head">
        <div className="ct-title">
          <strong className="ellipsis mono" title={info.model}>{info.model}</strong>
          <span className="ellipsis" title={info.name}>
            {info.name} · 推理强度 {EFFORT_TEXT[effort]}
            {stats.effortIgnored && <em className="effort-ignored" title="模型不接受推理强度参数，已按默认继续"> · 已回退默认</em>}
          </span>
        </div>
        <span className={`badge ${status}`}><span className="dot" />{STATUS_TEXT[status]}</span>
      </header>

      <div className="ct-stage">
        <CubeViewer ref={viewer} setupAlg={scramble} size={cubeSize} tempoScale={tempo} showHiddenFaces={showHiddenFaces} />
        <div className="ct-last" aria-live="polite">
          <span>最新动作</span>
          <b className="mono">{stats.lastMove ?? '—'}</b>
        </div>
        <div className="ct-progress"><div style={{ width: `${(stats.correctStickers / total) * 100}%` }} /></div>
      </div>

      {failReason && terminal && status !== 'solved' && <div className="ct-reason">{failReason}</div>}

      <div className="ct-metrics">
        <div><span>旋转次数</span><b>{stats.moves}<small> / QTM {stats.qtm}</small></b></div>
        <div title={stats.throttledCalls ? `另有 ${stats.throttledCalls} 次被供应商限流（429），不计入调用预算` : undefined}>
          <span>API 调用</span>
          <b>{stats.apiCalls}{stats.invalidToolCalls > 0 && <small> · 无效 {stats.invalidToolCalls}</small>}{stats.throttledCalls > 0 && <small> · 限流 {stats.throttledCalls}</small>}</b>
        </div>
        <div><span>整局耗时</span><b>{formatDuration(duration)}</b></div>
        <div title={usageNote(stats)}><span>输入 Token</span><b>{formatTokens(stats.inputTokens)}</b></div>
        <div title={usageNote(stats)}><span>输出 Token</span><b>{formatTokens(stats.outputTokens)}</b></div>
        <div title="推理 Token 属于输出 Token 的一部分，不重复计算"><span>推理 Token</span><b>{stats.reasoningTokens === null ? '未提供' : formatTokens(stats.reasoningTokens)}</b></div>
        <div><span>API 响应耗时</span><b>{formatMs(stats.lastLatencyMs)}<small> / 累计 {formatMs(stats.apiLatencyMs)}</small></b></div>
        <div title={costHint}><span>API 费用</span><b>{formatCost(stats.cost)}</b><small className="ct-sub">{costHint}</small></div>
        <div><span>已归位贴纸</span><b>{stats.correctStickers}/{total}</b></div>
      </div>

      <div className="ct-history" aria-label="操作历史" ref={historyBox}>
        {c.moves.length === 0 && <span className="empty">{status === 'queued' ? '排队等待并发名额…' : '等待模型调用 rotate_cube…'}</span>}
        {c.moves.map((m, i) => (
          <span key={i} className={`chip${i === c.moves.length - 1 ? ' last' : ''}`}>{m}<i>{i + 1}</i></span>
        ))}
      </div>

      {(lastCall?.text || lastLog) && (
        <div className={`ct-say ${lastLog && (!lastCall || lastLog.t > lastCall.t) ? lastLog.level : ''}`}>
          {lastLog && (!lastCall || lastLog.t > lastCall.t) ? lastLog.text : lastCall?.text}
        </div>
      )}

      <footer className="ct-actions">
        {controllable && !terminal && (
          <>
            {status === 'paused' ? (
              <button className="btn ghost sm" onClick={() => onAction('resume')}>继续</button>
            ) : (
              <button className="btn ghost sm" onClick={() => onAction('pause')} disabled={status !== 'running'}>暂停</button>
            )}
            <button className="btn ghost sm danger-text" onClick={() => onAction('stop')}>停止</button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={onFocus}>{focused ? '退出聚焦' : '聚焦查看'}</button>
      </footer>
    </article>
  );
}
