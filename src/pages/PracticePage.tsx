import { useCallback, useEffect, useRef, useState } from 'react';
import CubeViewer, { type CubeViewerHandle } from '../components/CubeViewer.tsx';
import HiddenFacesToggle from '../components/HiddenFacesToggle.tsx';
import Metric from '../components/Metric.tsx';
import MovePad from '../components/MovePad.tsx';
import {
  applyMove, correctStickers, formatAlg, isSolved, parseMove, quarterTurns, randomScramble, solvedState,
  type CubeState,
} from '../../shared/cube.ts';
import { formatDuration } from '../lib/format.ts';

interface HistoryItem {
  move: string;
  t: number;
}

export default function PracticePage() {
  const viewer = useRef<CubeViewerHandle>(null);
  const [scramble, setScramble] = useState('');
  const [state, setState] = useState<CubeState>(solvedState);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [startAt, setStartAt] = useState<number | null>(null);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [tempo, setTempo] = useState(1.5);
  const [showHiddenFaces, setShowHiddenFaces] = useState(false);
  const historyBox = useRef<HTMLDivElement>(null);

  // 用 ref 保存最新状态，保证连续快速操作时不会丢步
  const live = useRef({ state, startAt, endAt, scramble });
  const historyRef = useRef(history);
  const redoRef = useRef(redoStack);
  live.current = { state, startAt, endAt, scramble };
  historyRef.current = history;
  redoRef.current = redoStack;

  const htm = history.length;
  const qtm = history.reduce((n, h) => n + quarterTurns(parseMove(h.move)!), 0);
  const elapsed = startAt ? (endAt ?? now) - startAt : 0;
  const solvedRun = !!scramble && endAt !== null;

  useEffect(() => {
    if (!startAt || endAt) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [startAt, endAt]);

  const doMove = useCallback((token: string) => {
    const move = parseMove(token);
    if (!move) return;
    const cur = live.current;
    // 计时成绩一旦锁定，后续转动不会污染本局结果或历史。
    if (cur.endAt !== null) return;
    const t0 = cur.startAt ?? Date.now();
    if (!cur.startAt) setStartAt(t0);
    const next = applyMove(cur.state, move);
    live.current.state = next;
    live.current.startAt = t0;
    setState(next);
    viewer.current?.addMove(token);
    const t = Date.now() - t0;
    const nextHistory = [...historyRef.current, { move: token, t }];
    historyRef.current = nextHistory;
    setHistory(nextHistory);
    redoRef.current = [];
    setRedoStack([]);
    if (cur.scramble && !cur.endAt && isSolved(next)) {
      const finishedAt = Date.now();
      live.current.endAt = finishedAt;
      setEndAt(finishedAt);
    }
  }, []);

  const reset = (sc: string) => {
    setScramble(sc);
    const s = sc ? sc.split(' ').map((t) => parseMove(t)!).reduce(applyMove, solvedState()) : solvedState();
    setState(s);
    setHistory([]);
    historyRef.current = [];
    setRedoStack([]);
    redoRef.current = [];
    setStartAt(null);
    setEndAt(null);
    viewer.current?.reset(sc);
  };

  const beginReset = (sc: string) => {
    if ((historyRef.current.length || live.current.endAt !== null) && !window.confirm('开始新局会清空当前操作和成绩。确定继续吗？')) return;
    reset(sc);
  };

  const undo = () => {
    if (live.current.endAt !== null || !historyRef.current.length) return;
    const current = historyRef.current[historyRef.current.length - 1];
    const nextHistory = historyRef.current.slice(0, -1);
    const base = live.current.scramble
      ? live.current.scramble.split(' ').map((t) => parseMove(t)!).reduce(applyMove, solvedState())
      : solvedState();
    const nextState = nextHistory.map((h) => parseMove(h.move)!).reduce(applyMove, base);
    historyRef.current = nextHistory;
    setHistory(nextHistory);
    redoRef.current = [current.move, ...redoRef.current];
    setRedoStack(redoRef.current);
    live.current.state = nextState;
    setState(nextState);
    viewer.current?.reset(live.current.scramble);
    viewer.current?.jumpTo(nextHistory.map((h) => h.move).join(' '));
  };

  const redo = () => {
    if (live.current.endAt !== null || !redoRef.current.length) return;
    const token = redoRef.current[0];
    redoRef.current = redoRef.current.slice(1);
    setRedoStack(redoRef.current);
    doMove(token);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
      const m = /^Key([URFDLB])$/.exec(e.code);
      if (!m) return;
      e.preventDefault();
      doMove(m[1] + (e.shiftKey ? "'" : ''));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doMove]);

  useEffect(() => {
    const el = historyBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length]);

  const status = solvedRun ? 'solved' : startAt ? 'running' : 'idle';
  const progress = correctStickers(state);

  return (
    <main className="page">
      <div className="page-head">
        <h1>自由练习</h1>
      </div>
      <div className="arena">
        <div className="stack">
          <section className="glass panel">
            <h2 className="panel-title">
              转动操作 <span className="hint">键盘：字母键顺时针，Shift+字母逆时针</span>
            </h2>
            <MovePad onMove={doMove} />
          </section>
          <section className="glass panel">
            <h2 className="panel-title">魔方控制</h2>
            <div className="btn-row">
              <button className="btn primary" onClick={() => beginReset(formatAlg(randomScramble(20)))}>
                随机打乱
              </button>
              <button className="btn ghost" onClick={() => beginReset('')}>
                重置为复原
              </button>
              <button className="btn ghost" onClick={undo} disabled={!history.length || !!endAt}>撤销</button>
              <button className="btn ghost" onClick={redo} disabled={!redoStack.length || !!endAt}>重做</button>
            </div>
            <label className="field" style={{ marginTop: 16, marginBottom: 0 }}>
              <span>动画速度 · {tempo.toFixed(1)}×</span>
              <input type="range" min={0.5} max={5} step={0.5} value={tempo} onChange={(e) => setTempo(+e.target.value)} />
            </label>
          </section>
        </div>

        <section className="glass stage">
          <div className="stage-head">
            <span className={`badge ${status === 'idle' ? '' : status}`}>
              <span className="dot" />
              {status === 'solved' ? '复原成功' : status === 'running' ? '计时中' : '待操作'}
            </span>
            <div className="stage-tools">
              <span className="badge">面色一致度 {progress}/54（会波动）</span>
              <HiddenFacesToggle checked={showHiddenFaces} onChange={setShowHiddenFaces} />
            </div>
          </div>
          <CubeViewer ref={viewer} tempoScale={tempo} showHiddenFaces={showHiddenFaces} />
          <div className="stage-foot">
            <div className="scramble">
              <b>打乱</b>
              {scramble || '无（复原态）'}
            </div>
            <div className="drag-tip">按住魔方拖动以旋转视角 · 支持触屏</div>
          </div>
        </section>

        <div className="stack side-right">
          <section className="glass panel">
            <h2 className="panel-title">实时统计</h2>
            <div className="metrics">
              <Metric label="面转次数 (HTM)" value={htm} hl />
              <Metric label="四分之一转 (QTM)" value={qtm} hl />
              <Metric label="操作时间" value={formatDuration(elapsed)} sub={startAt ? (endAt ? '已停止' : '计时中') : '首次转动开始计时'} />
              <Metric label="转速 (TPS)" value={elapsed > 0 ? (htm / (elapsed / 1000)).toFixed(2) : '0.00'} sub="面转 / 秒" />
            </div>
            {solvedRun && (
              <div className="result-banner solved" style={{ marginTop: 14 }}>
                <strong>🎉 复原成功</strong>
                用时 {formatDuration(elapsed)}，共 {htm} 次面转 / {qtm} 次四分之一转。
                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button className="btn ghost sm" onClick={() => beginReset(formatAlg(randomScramble(20)))}>保留成绩并重新打乱</button>
                  <button className="btn ghost sm" onClick={() => reset('')}>继续练习（不计时）</button>
                </div>
              </div>
            )}
          </section>
          <section className="glass panel">
            <h2 className="panel-title">
              操作历史 <span className="hint">共 {history.length} 步</span>
            </h2>
            <div className="history" ref={historyBox}>
              {history.length === 0 && <div className="empty">还没有操作，点击左侧按键或使用键盘开始。</div>}
              {history.map((h, i) => (
                <span key={i} className={`chip${i === history.length - 1 ? ' last' : ''}`} title={`第 ${i + 1} 步 · ${formatDuration(h.t)}`}>
                  {h.move}
                  <i>{(h.t / 1000).toFixed(1)}s</i>
                </span>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
