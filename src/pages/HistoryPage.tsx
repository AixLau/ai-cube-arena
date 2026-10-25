import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DIFFICULTIES, type RunSummary } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { formatDate } from '../lib/format.ts';

export default function HistoryPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.runs().then(setRuns).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <h1>历史回放</h1>
      </div>
      <section className="glass panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>难度</th>
                <th>参赛模型</th>
                <th className="r">复原</th>
                <th>状态</th>
                <th>打乱</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const solved = r.contestants.filter((c) => c.status === 'solved').length;
                return (
                  <tr key={r.id}>
                    <td className="num">{formatDate(r.createdAt)}</td>
                    <td>{r.cubeSize ?? 3}×{r.cubeSize ?? 3} · {DIFFICULTIES.find((d) => d.id === r.difficulty)?.name.split(' · ')[0] ?? r.difficulty}</td>
                    <td className="cell-models">{r.contestants.map((c) => c.info.model).join('、')}</td>
                    <td className="r">{solved}/{r.contestants.length}</td>
                    <td>{r.status === 'running' ? <span className="badge running"><span className="dot" />进行中</span> : '已结束'}</td>
                    <td className="mono cell-sub">{r.scramble}</td>
                    <td>
                      {r.status === 'running'
                        ? <Link to={`/arena?run=${r.id}`}>观看直播 →</Link>
                        : <Link to={`/history/${r.id}`}>回放 →</Link>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!runs.length && <div className="empty" style={{ padding: 16 }}>{loading ? '加载中…' : error || '暂无评测记录。'}</div>}
        </div>
      </section>
    </main>
  );
}
