import { useEffect, useReducer } from 'react';
import type { ContestantState, RunEvent, RunSummary, TraceItem } from '../../shared/types.ts';
import { api } from './api.ts';

export interface LiveContestant {
  state: ContestantState;
  moves: string[];
  calls: Extract<TraceItem, { type: 'call' }>[];
  logs: { level: 'info' | 'warn' | 'error'; text: string; t: number }[];
  /** 本地收到最新统计的时间，用于运行中计时器平滑走秒 */
  statsAt: number;
}

export interface RunView {
  run: RunSummary | null;
  order: string[];
  cs: Record<string, LiveContestant>;
  finished: boolean;
  connection: 'idle' | 'open' | 'lost';
}

type Action = { type: 'reset' } | { type: 'event'; e: RunEvent } | { type: 'lost' };

const initial: RunView = { run: null, order: [], cs: {}, finished: false, connection: 'idle' };

function reducer(view: RunView, a: Action): RunView {
  if (a.type === 'reset') return initial;
  if (a.type === 'lost') return { ...view, connection: view.finished ? view.connection : 'lost' };
  const e = a.e;
  if (e.type === 'init' || e.type === 'done') {
    const cs = { ...view.cs };
    for (const c of e.run.contestants) {
      const prev = cs[c.info.id];
      cs[c.info.id] = prev ? { ...prev, state: c, statsAt: Date.now() } : { state: c, moves: [], calls: [], logs: [], statsAt: Date.now() };
    }
    return { run: e.run, order: e.run.contestants.map((c) => c.info.id), cs, finished: e.type === 'done', connection: 'open' };
  }
  const c = view.cs[e.cid];
  if (!c) return view;
  let next: LiveContestant = c;
  switch (e.type) {
    case 'status':
      next = { ...c, state: { ...c.state, status: e.status, failReason: e.reason ?? c.state.failReason } };
      break;
    case 'move':
      next = { ...c, moves: [...c.moves, e.move], state: { ...c.state, stats: { ...c.state.stats, moves: e.index, lastMove: e.move } } };
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
  return { ...view, cs: { ...view.cs, [e.cid]: next } };
}

/** 订阅一局评测的实时事件（服务端会先回放历史事件） */
export function useRunStream(runId: string | null): RunView {
  const [view, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!runId) return;
    const es = new EventSource(api.streamUrl(runId));
    let done = false;
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as RunEvent;
      if (e.type === 'done') {
        done = true;
        es.close();
      }
      dispatch({ type: 'event', e });
    };
    es.onerror = () => {
      es.close();
      if (!done) dispatch({ type: 'lost' });
    };
    return () => es.close();
  }, [runId]);
  return view;
}
