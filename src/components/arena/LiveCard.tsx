import { useEffect, useRef, useState } from 'react';
import { TERMINAL_STATUSES } from '../../../shared/types.ts';
import { EFFORT_TEXT, formatCost, formatDuration, formatMs, formatTokens, STATUS_TEXT } from '../../lib/format.ts';
import type { LiveContestant } from '../../lib/useRunStream.ts';
import { vendorOf, VENDOR_NAME } from '../../lib/vendor.ts';
import CubeViewer, { type CubeViewerHandle } from '../CubeViewer.tsx';
import ModelAvatar from '../ModelAvatar.tsx';

interface Props {
  c: LiveContestant;
  scramble: string | null;
  cubeSize: number;
  tempo: number;
  showHiddenFaces: boolean;
  controllable: boolean;
  showCube?: boolean;
  focused?: boolean;
  onAction(action: 'pause' | 'resume' | 'stop'): void;
  onFocus(): void;
}

/** 积压超过该步数时直接跳到最新状态，不再逐步播放（例如中途打开页面） */
const CATCH_UP_THRESHOLD = 8;

function failureHint(reason: string | null) {
  if (!reason) return '';
  if (/工具|rotate_cube|调用/.test(reason)) return '建议检查工具调用能力或降低难度后重试';
  if (/超时|时间/.test(reason)) return '建议增加最长运行时间或降低打乱难度';
  if (/限流|429/.test(reason)) return '建议降低并发或检查供应商限流策略';
  if (/预算|调用上限/.test(reason)) return '建议提高调用上限，或先用快速体验预设验证';
  return '可查看技术详情和完整轨迹定位原因';
}

function Ring({ value }: { value: number }) {
  const r = 26;
  const len = 2 * Math.PI * r;
  return (
    <svg className="ring" width="68" height="68" viewBox="0 0 68 68" aria-hidden="true">
      <circle cx="34" cy="34" r={r} className="ring-bg" />
      <circle cx="34" cy="34" r={r} className={`ring-fg${value >= 1 ? ' done' : ''}`} strokeDasharray={`${len * value} ${len}`} transform="rotate(-90 34 34)" />
      <text x="34" y="38" textAnchor="middle">{Math.round(value * 100)}%</text>
    </svg>
  );
}

export default function LiveCard({ c, scramble, cubeSize, tempo, showHiddenFaces, controllable, showCube = true, focused, onAction, onFocus }: Props) {
  const viewer = useRef<CubeViewerHandle>(null);
  const applied = useRef(0);
  const [now, setNow] = useState(Date.now());
  const [details, setDetails] = useState(false);
  const { info, status, failReason, stats } = c.state;
  const running = status === 'running';
  const terminal = TERMINAL_STATUSES.includes(status);

  // 每个模型的魔方只接收自己的转动事件，互不影响
  useEffect(() => {
    const pending = c.moves.length - applied.current;
    if (pending <= 0) return;
    if (pending > CATCH_UP_THRESHOLD) viewer.current?.jumpTo(c.moves.join(' '));
    else for (let i = applied.current; i < c.moves.length; i++) viewer.current?.addMove(c.moves[i]);
    applied.current = c.moves.length;
  }, [c.moves]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  const total = 6 * cubeSize * cubeSize;
  const progress = stats.correctStickers / total;
  const duration = stats.durationMs + (running ? Math.max(0, now - c.statsAt) : 0);
  const tokens = stats.inputTokens === null && stats.outputTokens === null ? null : (stats.inputTokens ?? 0) + (stats.outputTokens ?? 0);
  const vendor = vendorOf(info.model, info.host);
  const lastLog = c.logs[c.logs.length - 1];
  const statusLine =
    status === 'solved' ? '魔方已成功复原！'
    : status === 'queued' ? '排队等待并发名额…'
    : status === 'paused' ? '已暂停'
    : terminal ? (failReason ? `${failReason} · ${failureHint(failReason)}` : STATUS_TEXT[status])
    : lastLog && lastLog.level !== 'info' && lastLog.t > (c.calls.at(-1)?.t ?? 0) ? lastLog.text
    : c.calls.length ? '分析当前状态，规划后续步骤…' : '正在思考第一步…';

  return (
    <article className={`live-card glass st-${status}${focused ? ' focused' : ''}`}>
      <header className="lc-head">
        <ModelAvatar model={info.model} host={info.host} size={42} />
        <div className="lc-title">
          <small className="ellipsis">{vendor ? VENDOR_NAME[vendor] : info.name} · {info.name}</small>
          <b className="ellipsis" title={info.model}>{info.model}</b>
        </div>
        <span className={`pill ${status}`}>
          {status === 'solved' ? '✦ 已复原' : status === 'running' ? '✦ 求解中' : STATUS_TEXT[status]}
        </span>
      </header>

      <div className="lc-body">
        <div className="lc-cube">
          {showCube && scramble !== null ? <CubeViewer ref={viewer} setupAlg={scramble} size={cubeSize} tempoScale={tempo} showHiddenFaces={showHiddenFaces} /> : <div className="cube-deferred"><b>{scramble === null ? '初始状态暂不公开' : '3D 视图已暂停'}</b><span>{scramble === null ? '评测结束后可在报告中回放' : '模型数量较多，聚焦后加载'}</span></div>}
        </div>
        <dl className="lc-stats">
          <div className="lc-ring"><Ring value={progress} /><span>{status === 'solved' ? '已复原' : '面色一致度'}{status !== 'solved' && <small>会波动</small>}</span></div>
          <div><dd className="num">{stats.moves}</dd><dt>{terminal ? '总步数' : '当前步数'}</dt></div>
          <div><dd className="num">{formatDuration(duration)}</dd><dt>{terminal ? '总用时' : '已用时间'}</dt></div>
          <div><dd className="num">{stats.apiCalls}</dd><dt>API 调用</dt></div>
        </dl>
      </div>

      <div className="lc-moves">
        <span>最新操作</span>
        <div>
          {c.moves.slice(-6).map((m, i, arr) => (
            <em key={c.moves.length - arr.length + i} className={i === arr.length - 1 && running ? 'now' : ''}>{m}</em>
          ))}
          {!c.moves.length && <small>暂无</small>}
        </div>
      </div>

      <div className={`lc-status ${status}`}>
        {status === 'solved' ? (
          <span className="ok-mark" aria-hidden="true">✓</span>
        ) : running ? (
          <span className="spinner" aria-hidden="true" />
        ) : null}
        <span className="ellipsis">{statusLine}</span>
      </div>

      <details className="lc-details" open={details} onToggle={(e) => setDetails(e.currentTarget.open)}>
        <summary>技术详情</summary>
        <dl>
          <div><dt>QTM</dt><dd>{stats.qtm}</dd></div>
          <div><dt>工具调用</dt><dd>{stats.toolCalls}</dd></div>
          <div><dt>无效调用</dt><dd>{stats.invalidToolCalls}</dd></div>
          <div><dt>限流</dt><dd>{stats.throttledCalls}</dd></div>
          <div><dt>Token</dt><dd>{formatTokens(tokens)}{stats.usageMissingCalls ? `（${stats.usageMissingCalls} 次未知）` : ''}</dd></div>
          <div><dt>费用</dt><dd>{formatCost(stats.cost)}</dd></div>
          <div><dt>最近响应</dt><dd>{formatMs(stats.lastLatencyMs)}</dd></div>
          <div><dt>累计响应</dt><dd>{formatMs(stats.apiLatencyMs)}</dd></div>
        </dl>
      </details>

      <footer className="lc-foot">
        <small>推理 {EFFORT_TEXT[info.reasoningEffort ?? 'default']}{stats.effortIgnored ? '（已回退默认）' : ''}</small>
        <span style={{ flex: 1 }} />
        {controllable && !terminal && (
          status === 'paused'
            ? <button className="mini-btn" onClick={() => onAction('resume')}>继续</button>
            : <button className="mini-btn" onClick={() => onAction('pause')} disabled={!running}>暂停</button>
        )}
        {controllable && !terminal && <button className="mini-btn danger-text" onClick={() => {
          if (window.confirm(`停止 ${info.model} 后将不再继续调用 API，本局结果会标记为已停止。已产生的费用无法恢复。确定停止吗？`)) onAction('stop');
        }}>停止</button>}
        <button className="mini-btn" onClick={onFocus}>{focused ? '收起' : '聚焦'}</button>
      </footer>
    </article>
  );
}
