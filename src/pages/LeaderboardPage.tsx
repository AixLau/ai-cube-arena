import { useEffect, useMemo, useState } from 'react';
import { CUBE_SIZE_INFO, scrambleLengthOf, type ContestantState, type PublicRunSummary } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { EFFORT_TEXT, formatCost, formatDate, formatDuration, formatTokens } from '../lib/format.ts';

interface Row {
  key: string;
  name: string;
  host: string;
  model: string;
  effort: string;
  runs: number;
  solved: number;
  bestMoves: number | null;
  avgMoves: number | null;
  /** 仅在全部记录都有值时给出平均，否则为 null（未知） */
  avgTokens: number | null;
  avgCost: number | null;
  avgMs: number;
  failReasons: Record<string, number>;
  lastUpdated: string;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const avgOrNull = (xs: (number | null)[]) => (xs.length && xs.every((x) => x !== null) ? avg(xs as number[]) : null);

export default function LeaderboardPage({ embedded = false }: { embedded?: boolean }) {
  const [runs, setRuns] = useState<PublicRunSummary[]>([]);
  const [steps, setSteps] = useState<number | 'all'>('all');
  const [size, setSize] = useState(3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.runs().then(setRuns).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, ContestantState[]>();
    for (const r of runs) {
      if (r.status !== 'finished' || (r.cubeSize ?? 3) !== size || (steps !== 'all' && scrambleLengthOf(r) !== steps)) continue;
      // 手动停止的不计入排行
      for (const c of r.contestants.filter((x) => x.status !== 'stopped')) {
        // 以「配置标识 + 模型 ID」区分参赛者：同一配置换了模型视为不同选手
        const key = `${c.info.configId}::${c.info.model}::${c.info.reasoningEffort ?? 'default'}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
    }
    return [...groups.entries()]
      .map(([key, cs]) => {
        const ok = cs.filter((c) => c.status === 'solved');
        const last = cs[0].info;
        const failReasons: Record<string, number> = {};
        for (const c of cs) if (c.status !== 'solved' && c.failReason) failReasons[c.failReason] = (failReasons[c.failReason] ?? 0) + 1;
        return {
          key,
          name: last.name,
          host: last.host,
          model: last.model,
          effort: EFFORT_TEXT[last.reasoningEffort ?? 'default'],
          runs: cs.length,
          solved: ok.length,
          bestMoves: ok.length ? Math.min(...ok.map((c) => c.stats.moves)) : null,
          avgMoves: ok.length ? avg(ok.map((c) => c.stats.moves)) : null,
          avgTokens: avgOrNull(cs.map((c) => (c.stats.inputTokens === null || c.stats.outputTokens === null ? null : c.stats.inputTokens + c.stats.outputTokens))),
          avgCost: avgOrNull(cs.map((c) => c.stats.cost)),
          avgMs: avg(cs.map((c) => c.stats.durationMs)),
          failReasons,
          lastUpdated: runs.filter((r) => r.status === 'finished' && (r.cubeSize ?? 3) === size && (steps === 'all' || scrambleLengthOf(r) === steps) && r.contestants.some((c) => `${c.info.configId}::${c.info.model}::${c.info.reasoningEffort ?? 'default'}` === key)).map((r) => r.createdAt).sort().at(-1) ?? '',
        };
      })
      .sort((a, b) => {
        const aFormal = a.runs >= 20 ? 1 : 0;
        const bFormal = b.runs >= 20 ? 1 : 0;
        return bFormal - aFormal || b.solved / b.runs - a.solved / a.runs || (a.avgMoves ?? 1e9) - (b.avgMoves ?? 1e9) || a.avgMs - b.avgMs;
      });
  }, [runs, steps, size]);

  // 当前阶数下出现过的打乱步数
  const stepOptions = useMemo(
    () => [...new Set(runs.filter((r) => r.status === 'finished' && (r.cubeSize ?? 3) === size).map(scrambleLengthOf))].sort((a, b) => a - b),
    [runs, size],
  );

  return (
    <Wrap embedded={embedded}>
      <div className="page-head row">
        {!embedded && <h1>排行榜</h1>}
        <div className="btn-row">
        <div className="tabs">
          {CUBE_SIZE_INFO.map((c) => (
            <button key={c.n} className={c.n === size ? 'on' : ''} onClick={() => setSize(c.n)}>{c.name}</button>
          ))}
        </div>
        <select value={steps} onChange={(e) => setSteps(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="打乱步数">
          <option value="all">全部打乱步数</option>
          {stepOptions.map((n) => <option key={n} value={n}>{n} 步</option>)}
        </select>
        </div>
      </div>
      <p className="field-hint leaderboard-note">严格公平榜：已按阶数和打乱步数筛选；停止的模型不计入。少于 5 局标记“样本不足”，5–19 局为“参考排名”，20 局以上进入正式排名。</p>
      <section className="glass panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>排名</th>
                <th>模型</th>
                <th className="r">参赛次数</th>
                <th className="r">成功率</th>
                <th className="r">最佳步数</th>
                <th className="r">平均步数</th>
                <th className="r">平均 Token</th>
                <th className="r">平均费用</th>
                <th className="r">平均耗时</th>
                <th>主要失败原因</th>
                <th>最近更新</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const topFail = Object.entries(r.failReasons).sort((a, b) => b[1] - a[1])[0];
                return (
                  <tr key={r.key}>
                    <td>{r.runs >= 20 ? <span className={`rank r${i + 1}`}>{i + 1}</span> : <span className="tag warn">{r.runs < 5 ? '样本不足' : '参考排名'}</span>}</td>
                    <td><b className="mono">{r.model}</b><div className="cell-sub">{r.name} · 推理 {r.effort}</div></td>
                    <td className="r">{r.runs}<div className="cell-sub">{r.runs < 5 ? '需 ≥5 局' : r.runs < 20 ? '需 ≥20 局' : '正式排名'}</div></td>
                    <td className="r">{Math.round((r.solved / r.runs) * 100)}%</td>
                    <td className="r">{r.bestMoves ?? '—'}</td>
                    <td className="r">{r.avgMoves !== null ? r.avgMoves.toFixed(1) : '—'}</td>
                    <td className="r">{r.avgTokens === null ? '未知' : formatTokens(Math.round(r.avgTokens))}</td>
                    <td className="r">{formatCost(r.avgCost)}</td>
                    <td className="r">{formatDuration(r.avgMs)}</td>
                    <td className="cell-reason">{topFail ? `${topFail[0]}（${topFail[1]} 次）` : '—'}</td>
                    <td className="cell-sub">{r.lastUpdated ? formatDate(r.lastUpdated) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length && <div className="empty" style={{ padding: 16 }}>{loading ? '加载中…' : error || '该难度暂无评测记录。'}</div>}
        </div>
      </section>
    </Wrap>
  );
}

function Wrap({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  return embedded ? <>{children}</> : <main className="page">{children}</main>;
}
