import type { ContestantState } from '../../shared/types.ts';
import { EFFORT_TEXT, formatCost, formatDuration, formatMs, formatTokens, STATUS_TEXT } from '../lib/format.ts';

/** 排名：先比是否复原，再比旋转次数、耗时；未复原的按归位贴纸数 */
export function rankContestants(list: ContestantState[]): ContestantState[] {
  return [...list].sort((a, b) => {
    const sa = a.status === 'solved' ? 0 : 1;
    const sb = b.status === 'solved' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if (sa === 0) return a.stats.moves - b.stats.moves || a.stats.durationMs - b.stats.durationMs;
    return b.stats.correctStickers - a.stats.correctStickers || a.stats.moves - b.stats.moves;
  });
}

export default function ComparisonTable({ contestants }: { contestants: ContestantState[] }) {
  const ranked = rankContestants(contestants);
  const solved = contestants.filter((c) => c.status === 'solved').length;
  return (
    <div>
      <p className="hint-text" style={{ margin: '0 0 10px' }}>
        成功率 <b className="num">{solved}/{contestants.length}</b>（{contestants.length ? Math.round((solved / contestants.length) * 100) : 0}%）
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>排名</th>
              <th>模型</th>
              <th>结果</th>
              <th className="r">旋转</th>
              <th className="r">QTM</th>
              <th className="r">API 调用</th>
              <th className="r">输入 Token</th>
              <th className="r">输出 Token</th>
              <th className="r">推理 Token</th>
              <th className="r">费用</th>
              <th className="r">API 耗时</th>
              <th className="r">整局耗时</th>
              <th>失败原因</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((c, i) => (
              <tr key={c.info.id}>
                <td><span className={`rank r${c.status === 'solved' ? i + 1 : 0}`}>{i + 1}</span></td>
                <td>
                  <b className="mono">{c.info.model}</b>
                  <div className="cell-sub">{c.info.name} · 推理 {EFFORT_TEXT[c.info.reasoningEffort ?? 'default']}{c.stats.effortIgnored ? '（已回退默认）' : ''}</div>
                </td>
                <td><span className={`badge ${c.status}`} style={{ padding: '1px 10px', fontSize: 12 }}>{STATUS_TEXT[c.status]}</span></td>
                <td className="r">{c.stats.moves}</td>
                <td className="r">{c.stats.qtm}</td>
                <td className="r">{c.stats.apiCalls}{c.stats.throttledCalls > 0 && <div className="cell-sub">限流 {c.stats.throttledCalls}</div>}</td>
                <td className="r" title={c.stats.usageMissingCalls ? `${c.stats.usageMissingCalls} 次调用未返回用量` : ''}>
                  {formatTokens(c.stats.inputTokens)}{c.stats.usageMissingCalls > 0 && c.stats.inputTokens !== null ? '*' : ''}
                </td>
                <td className="r">{formatTokens(c.stats.outputTokens)}{c.stats.usageMissingCalls > 0 && c.stats.outputTokens !== null ? '*' : ''}</td>
                <td className="r">{c.stats.reasoningTokens === null ? '—' : formatTokens(c.stats.reasoningTokens)}</td>
                <td className="r">{formatCost(c.stats.cost)}</td>
                <td className="r">{formatMs(c.stats.apiLatencyMs)}</td>
                <td className="r">{formatDuration(c.stats.durationMs)}</td>
                <td className="cell-reason">{c.status === 'solved' ? '—' : c.failReason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {contestants.some((c) => c.stats.usageMissingCalls > 0 && (c.stats.inputTokens !== null || c.stats.outputTokens !== null)) && <p className="hint-text">* 部分 API 调用未返回用量，数值仅为已返回部分之和。</p>}
    </div>
  );
}
