import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ContestantState, PublicRunRecord, PublicRunSummary, RunEvent, RunEventEnvelope, RunRecord, RunSummary, TraceItem } from '../../shared/types.ts';
import { api } from './api.ts';

export interface LiveContestant {
  state: ContestantState;
  moves: string[];
  /** 与 moves 一一对应的时间（相对评测开始，毫秒） */
  moveTimes: number[];
  calls: Extract<TraceItem, { type: 'call' }>[];
  logs: { level: 'info' | 'warn' | 'error'; text: string; t: number }[];
  /** 本地收到最新统计的时间，用于运行中计时器平滑走秒 */
  statsAt: number;
}

export interface RunView {
  run: RunSummary | PublicRunSummary | null;
  order: string[];
  cs: Record<string, LiveContestant>;
  finished: boolean;
  connection: 'idle' | 'open' | 'lost';
  /** 最近一次收到服务端事件或成功恢复记录的时间 */
  lastUpdatedAt: number | null;
  /** 手动重连；保留已有事件，不会创建新评测 */
  reconnect(): void;
}

type Action = { type: 'reset' } | { type: 'event'; e: RunEvent } | { type: 'hydrate'; record: RunRecord | PublicRunRecord } | { type: 'connection'; state: 'open' | 'lost' };

const initial: Omit<RunView, 'reconnect'> = { run: null, order: [], cs: {}, finished: false, connection: 'idle', lastUpdatedAt: null };

function blankContestant(state: ContestantState): LiveContestant {
  return { state, moves: [], moveTimes: [], calls: [], logs: [], statsAt: Date.now() };
}

function fromRecord(record: RunRecord | PublicRunRecord): Omit<RunView, 'reconnect'> {
  const cs: Record<string, LiveContestant> = {};
  for (const c of record.contestants) {
    const live = blankContestant(c);
    for (const item of record.traces[c.info.id] ?? []) {
      if (item.type === 'move') {
        live.moves.push(item.move);
        live.moveTimes.push(item.t);
      } else if (item.type === 'call') live.calls.push(item);
      else if (item.type === 'log') live.logs.push(item);
    }
    cs[c.info.id] = live;
  }
  return {
    run: record,
    order: record.contestants.map((c) => c.info.id),
    cs,
    finished: record.status === 'finished',
    connection: 'open',
    lastUpdatedAt: Date.now(),
  };
}

function reducer(view: RunView, a: Action): RunView {
  if (a.type === 'reset') return { ...initial, reconnect: view.reconnect };
  if (a.type === 'hydrate') return { ...fromRecord(a.record), reconnect: view.reconnect };
  if (a.type === 'connection') return { ...view, connection: a.state };
  const e = a.e;
  if (e.type === 'reset') return view;
  if (e.type === 'init' || e.type === 'done') {
    const cs = { ...view.cs };
    for (const c of e.run.contestants) {
      const prev = cs[c.info.id];
      cs[c.info.id] = prev ? { ...prev, state: c, statsAt: Date.now() } : { state: c, moves: [], moveTimes: [], calls: [], logs: [], statsAt: Date.now() };
    }
    return { ...view, run: e.run, order: e.run.contestants.map((c) => c.info.id), cs, finished: e.type === 'done', connection: 'open', lastUpdatedAt: Date.now() };
  }
  const c = view.cs[e.cid];
  if (!c) return view;
  let next: LiveContestant = c;
  switch (e.type) {
    case 'status':
      next = { ...c, state: { ...c.state, status: e.status, failReason: e.reason ?? c.state.failReason } };
      break;
    case 'move':
      next = { ...c, moves: [...c.moves, e.move], moveTimes: [...c.moveTimes, e.t], state: { ...c.state, stats: { ...c.state.stats, moves: e.index, lastMove: e.move } } };
      break;
    case 'stats':
      next = { ...c, state: { ...c.state, stats: e.stats }, statsAt: Date.now() };
      break;
    case 'call':
      next = { ...c, calls: [...c.calls, e.item] };
      break;
    case 'log':
      next = { ...c, logs: [...c.logs, { level: e.level, text: e.text, t: e.t }] };
      break;
  }
  return { ...view, cs: { ...view.cs, [e.cid]: next }, connection: 'open', lastUpdatedAt: Date.now() };
}

function eventKey(e: RunEvent): string {
  if (e.type === 'init' || e.type === 'done' || e.type === 'reset') return `${e.type}:${e.run.id}:${e.run.finishedAt ?? ''}`;
  if (e.type === 'move') return `move:${e.cid}:${e.index}`;
  if (e.type === 'call') return `call:${e.cid}:${e.item.n}`;
  if (e.type === 'log') return `log:${e.cid}:${e.t}:${e.text}`;
  if (e.type === 'status') return `status:${e.cid}:${e.t}:${e.status}`;
  return `stats:${e.cid}:${JSON.stringify(e.stats)}`;
}

/** 订阅一局评测的实时事件（服务端会先回放历史事件） */
export function useRunStream(runId: string | null): RunView {
  const [retryVersion, setRetryVersion] = useState(0);
  const reconnect = useCallback(() => setRetryVersion((n) => n + 1), []);
  const [view, dispatch] = useReducer(reducer, { ...initial, reconnect });
  const seenRef = useRef<Set<string> | null>(null);
  const seenRunRef = useRef<string | null>(null);
  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!runId) return;
    if (seenRunRef.current !== runId) {
      seenRunRef.current = runId;
      seenRef.current = new Set();
    }
    if (!seenRef.current) seenRef.current = new Set();
    const es = new EventSource(api.streamUrl(runId));
    let done = false;
    let recoveryInFlight = false;
    const seen = seenRef.current;
    const recover = () => {
      if (recoveryInFlight) return;
      recoveryInFlight = true;
      void api.run(runId).then((record) => {
        dispatch({ type: 'hydrate', record });
        done = record.status === 'finished';
        if (done) es.close();
      }).catch(() => {}).finally(() => { recoveryInFlight = false; });
    };
    es.onopen = () => dispatch({ type: 'connection', state: 'open' });
    es.onmessage = (msg) => {
      let e: RunEvent;
      let hasSeq = false;
      try {
        const payload = JSON.parse(msg.data) as RunEventEnvelope | RunEvent;
        e = 'event' in payload ? payload.event : payload;
        hasSeq = 'event' in payload && typeof (payload as RunEventEnvelope).seq === 'number';
        if (hasSeq) {
          const seq = (payload as RunEventEnvelope).seq;
          if (seen.has(`seq:${seq}`)) return;
          seen.add(`seq:${seq}`);
        }
      } catch { return; }
      if (!hasSeq) {
        if (seen.has(eventKey(e))) return;
        seen.add(eventKey(e));
      }
      if (e.type === 'done') {
        done = true;
        es.close();
      }
      if (e.type === 'reset') { recover(); return; }
      dispatch({ type: 'event', e });
    };
    es.onerror = () => {
      if (done) return;
      dispatch({ type: 'connection', state: 'lost' });
      recover();
    };
    return () => es.close();
  }, [runId, retryVersion]);
  return { ...view, reconnect };
}
