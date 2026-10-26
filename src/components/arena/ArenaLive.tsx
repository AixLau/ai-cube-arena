import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CUBE_SIZE_INFO, scrambleLevelName, TERMINAL_STATUSES } from '../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { formatDate } from '../../lib/format.ts';
import type { RunView } from '../../lib/useRunStream.ts';
import CubeViewer from '../CubeViewer.tsx';
import HiddenFacesToggle from '../HiddenFacesToggle.tsx';
import ModelAvatar from '../ModelAvatar.tsx';
import LiveCard from './LiveCard.tsx';
import LogPanel from './LogPanel.tsx';

const SPEEDS = [0.5, 1, 1.5, 2, 3];

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export default function ArenaLive({ runId, view, onNew }: { runId: string; view: RunView; onNew(): void }) {
  const [speed, setSpeed] = useState(1);
  const [showHiddenFaces, setShowHiddenFaces] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [error, setError] = useState('');

  const run = view.run;
  const contestants = view.order.map((id) => view.cs[id]).filter(Boolean);
  // 断线仍属于同一场正在运行的评测：配置保持锁定，不能重新开始。
  const live = !view.finished && run?.status === 'running';
  const connected = view.connection === 'open';
  const statuses = contestants.map((c) => c.state.status);
  const allPaused = live && statuses.some((s) => s === 'paused') && !statuses.some((s) => s === 'running' || s === 'queued');
  const done = statuses.filter((s) => TERMINAL_STATUSES.includes(s)).length;

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [live]);

  const elapsed = useMemo(() => {
    if (!run) return 0;
    const end = run.finishedAt ? Date.parse(run.finishedAt) : view.finished ? Math.max(...contestants.map((c) => Date.parse(run.createdAt) + c.state.stats.durationMs)) : now;
    return end - Date.parse(run.createdAt);
  }, [run, now, view.finished, contestants]);

  if (!run) {
    return (
      <main className="page wide">
        <p className="hint-text">{view.connection === 'lost' ? '实时连接暂时不可用，正在保留这场测试的状态。' : '正在连接测试…'}</p>
        {view.connection === 'lost' && <button className="btn ghost" onClick={view.reconnect}>立即重连</button>}
      </main>
    );
  }

  const n = run.cubeSize ?? 3;
  const scramble = 'scramble' in run ? run.scramble : null;
  const initialState = 'initialState' in run ? run.initialState : null;
  const sizeInfo = CUBE_SIZE_INFO.find((c) => c.n === n);
  const steps = run.scrambleLength ?? (scramble ? scramble.split(' ').filter(Boolean).length : 0);
  const act = (fn: () => Promise<unknown>) => fn().catch((e) => setError((e as Error).message));
  const focusedC = focused ? view.cs[focused] : null;
  const stopAll = () => {
    if (!window.confirm('停止后所有模型将不再继续调用 API，本局结果会标记为已停止。已产生的费用无法恢复。确定停止吗？')) return;
    act(() => api.runAction(runId, 'stop'));
  };
  const lastUpdated = view.lastUpdatedAt ? `${Math.max(0, Math.floor((Date.now() - view.lastUpdatedAt) / 1000))} 秒前` : '尚未收到更新';

  const copyState = async () => {
    if (!scramble || !initialState) {
      setError('评测结束后才能复制完整初始状态');
      return;
    }
    try {
      await navigator.clipboard.writeText(`打乱：${scramble}\n初始状态（URFDLB）：${initialState}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('无法写入剪贴板');
    }
  };

  const cardProps = (id: string) => ({
    scramble,
    cubeSize: n,
    tempo: speed * 1.5,
    showHiddenFaces,
    controllable: live && connected,
    showCube: contestants.length <= 8 || focused === id,
    onAction: (a: 'pause' | 'resume' | 'stop') => act(() => api.contestantAction(runId, id, a)),
    onFocus: () => setFocused(focused === id ? null : id),
  });

  return (
    <main className="page wide live">
      <header className="live-head">
        <div className="lh-title">
          <h1>{n}×{n} 魔方 · AI 模型能力测试</h1>
          <p>已选择 {contestants.length} 个模型 · 统一初始状态 · 独立并行求解 · 实时可视化每个模型的推理过程</p>
        </div>
        <div className={`lh-timer glass ${live ? (view.connection === 'lost' ? 'lost' : allPaused ? 'paused' : 'running') : 'done'}`}>
          <span className="lh-state"><span className="dot" />{view.connection === 'lost' ? '连接中断 · 服务端仍在运行' : live ? (allPaused ? '测试已暂停' : '测试进行中') : '测试已完成'}</span>
          <b className="num">{clock(elapsed)}</b>
        </div>
        <div className="lh-actions">
          {live && connected ? (
            <>
              <button className="ctl-btn" onClick={() => act(() => api.runAction(runId, allPaused ? 'resume' : 'pause'))}>
                <svg className="ctl-ic pause" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{allPaused ? <path d="M7 4.5v15l12.5-7.5z" /> : <><rect x="5" y="4" width="5" height="16" rx="1.5" /><rect x="14" y="4" width="5" height="16" rx="1.5" /></>}</svg>{allPaused ? '继续' : '暂停'}
              </button>
              <button className="ctl-btn" onClick={stopAll}>
                <span className="ctl-ic stop" aria-hidden="true" />停止
              </button>
            </>
          ) : live && !connected ? (
            <>
              <button className="ctl-btn primary" onClick={view.reconnect}>立即重连</button>
              <button className="ctl-btn danger" onClick={stopAll}><span className="ctl-ic stop" aria-hidden="true" />终止评测</button>
            </>
          ) : (
            <>
              <Link to={`/reports/${runId}`} className="ctl-btn">查看报告</Link>
              <button className="ctl-btn primary" onClick={onNew}>新建测试</button>
            </>
          )}
          <HiddenFacesToggle checked={showHiddenFaces} onChange={setShowHiddenFaces} />
          <div className="ctl-speed">
            <button className="ctl-btn" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} title="切换动画速度">
              <span aria-hidden="true">⏱</span>{speed.toFixed(1)}x
            </button>
            <small>动画速度</small>
          </div>
        </div>
      </header>
      {error && <p className="form-error">{error}</p>}
      {view.connection === 'lost' && (
        <div className="connection-banner" role="status">
          <span><b>实时连接已断开。</b> 评测仍在服务端运行，配置已锁定；最近一次更新：{lastUpdated}。</span>
          <span className="btn-row"><button className="btn ghost sm" onClick={view.reconnect}>立即重连</button><button className="btn danger sm" onClick={stopAll}>终止评测</button></span>
        </div>
      )}

      <div className="live-grid">
        <div className={`live-cards n${Math.min(contestants.length, 4)}`}>
          {contestants.map((c) => <LiveCard key={c.state.info.id} c={c} {...cardProps(c.state.info.id)} />)}
        </div>

        <aside className="live-side">
          <section className="glass side-card">
            <header>
              <h2>测试信息</h2>
              <button className="link-btn" onClick={() => setShowConfig(!showConfig)}>{showConfig ? '收起配置' : '查看配置 →'}</button>
            </header>
            <dl className="info-rows">
              <dt>魔方类型</dt><dd>{n}×{n} {sizeInfo?.level}</dd>
              <dt>打乱步数</dt><dd>{steps} 步（{scrambleLevelName(steps)}）</dd>
              <dt>初始状态</dt><dd>统一随机打乱（已同步）</dd>
              <dt>参测模型</dt>
              <dd className="info-avatars">
                {contestants.slice(0, 5).map((c) => <ModelAvatar key={c.state.info.id} model={c.state.info.model} host={c.state.info.host} size={22} />)}
                <span>{contestants.length} 个</span>
              </dd>
              <dt>完成情况</dt><dd>{done} / {contestants.length} 已结束</dd>
              <dt>开始时间</dt><dd className="num">{formatDate(run.createdAt)}</dd>
              <dt>运行时长</dt><dd className="num">{clock(elapsed)}</dd>
            </dl>
            {showConfig && (
              <dl className="info-rows config">
                <dt>运行限制</dt><dd>手动停止</dd>
              </dl>
            )}
          </section>

          <section className="glass side-card transparency">
            <header><h2>评测透明度</h2></header>
            <p>所有模型使用同一初始状态，并独立维护自己的魔方。</p>
            <ul>
              <li><b>模型会收到</b> canonical cube state、展开图、state hash 和最近工具结果。</li>
              <li><b>模型不会收到</b> 初始打乱公式、其他模型的状态或动作。</li>
              <li><b>模型通过</b> <code>rotate_cube</code> 工具提交动作。</li>
            </ul>
          </section>

          <section className="glass side-card">
            <header>
              <h2>初始打乱状态</h2>
              <button className="btn soft sm" onClick={copyState}>{copied ? '已复制' : '⧉ 复制状态'}</button>
            </header>
            <div className="init-state">
              {scramble ? <><div className="init-cube"><CubeViewer setupAlg={scramble} size={n} /></div><div className="init-alg mono">{scramble}</div></> : <p className="hint-text">评测进行中，初始打乱在服务端受保护；结束后可在报告中查看。</p>}
            </div>
          </section>
        </aside>
      </div>

      <LogPanel runId={runId} contestants={contestants} finished={!live} />

      {live && (
        <div className="mobile-run-bar" role="toolbar" aria-label="评测控制">
          <span>评测进行中 · {done}/{contestants.length} 完成</span>
          {connected ? <button onClick={() => act(() => api.runAction(runId, allPaused ? 'resume' : 'pause'))}>{allPaused ? '继续全部' : '暂停全部'}</button> : <button onClick={view.reconnect}>重连</button>}
          <button className="danger-text" onClick={stopAll}>终止全部</button>
        </div>
      )}

      {focusedC && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setFocused(null)}>
          <div className="focus-modal">
            <LiveCard key={`focus-${focusedC.state.info.id}`} c={focusedC} {...cardProps(focusedC.state.info.id)} focused />
          </div>
        </div>
      )}
    </main>
  );
}
