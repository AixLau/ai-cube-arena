import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { scrambleLengthOf, type PublicRunSummary } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { formatDate } from '../lib/format.ts';

export default function HistoryPage({ embedded = false }: { embedded?: boolean }) {
  const [runs, setRuns] = useState<PublicRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'finished'>('all');
  const [sizeFilter, setSizeFilter] = useState<'all' | number>('all');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    api.runs().then(setRuns).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (sizeFilter !== 'all' && (r.cubeSize ?? 3) !== sizeFilter) return false;
      if (q && !r.contestants.some((c) => c.info.model.toLowerCase().includes(q) || c.info.name.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [runs, query, statusFilter, sizeFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize);

  return (
    <Wrap embedded={embedded}>
      {!embedded && (
        <div className="page-head">
          <h1>测试记录</h1>
        </div>
      )}
      <div className="history-filters">
        <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="搜索模型名称…" aria-label="搜索模型" />
        <select value={sizeFilter} onChange={(e) => { setSizeFilter(e.target.value === 'all' ? 'all' : Number(e.target.value)); setPage(1); }} aria-label="魔方阶数">
          <option value="all">全部阶数</option><option value={2}>2×2</option><option value={3}>3×3</option><option value={4}>4×4</option><option value={5}>5×5</option>
        </select>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(1); }} aria-label="运行状态">
          <option value="all">全部状态</option><option value="running">进行中</option><option value="finished">已结束</option>
        </select>
        <span className="field-hint">共 {filtered.length} 条</span>
      </div>
      <section className="glass panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>挑战</th>
                <th>参赛模型</th>
                <th className="r">复原</th>
                <th>状态</th>
                <th>打乱</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const solved = r.contestants.filter((c) => c.status === 'solved').length;
                return (
                  <tr key={r.id}>
                    <td className="num">{formatDate(r.createdAt)}</td>
                    <td>{r.cubeSize ?? 3}×{r.cubeSize ?? 3} · {scrambleLengthOf(r)} 步</td>
                    <td className="cell-models">{r.contestants.map((c) => c.info.model).join('、')}</td>
                    <td className="r">{solved}/{r.contestants.length}</td>
                    <td>{r.status === 'running' ? <span className="badge running"><span className="dot" />进行中</span> : '已结束'}</td>
                    <td className="mono cell-sub">题目受保护</td>
                    <td>
                      {r.status === 'running'
                        ? <Link to={`/arena?run=${r.id}`}>观看直播 →</Link>
                        : <Link to={`/reports/${r.id}`}>回放 →</Link>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visible.length && <div className="empty" style={{ padding: 16 }}>{loading ? '加载中…' : error || '没有符合条件的评测记录。'}</div>}
        </div>
        {pageCount > 1 && <div className="pagination"><button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage((n) => Math.max(1, n - 1))}>上一页</button><span>第 {Math.min(page, pageCount)} / {pageCount} 页</span><button className="btn ghost sm" disabled={page >= pageCount} onClick={() => setPage((n) => Math.min(pageCount, n + 1))}>下一页</button></div>}
      </section>
    </Wrap>
  );
}

function Wrap({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  return embedded ? <>{children}</> : <main className="page">{children}</main>;
}
