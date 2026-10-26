import { useSearchParams } from 'react-router-dom';
import HistoryPage from './HistoryPage.tsx';
import LeaderboardPage from './LeaderboardPage.tsx';

/** 测试报告：历次测试记录与模型排行榜 */
export default function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'leaderboard' ? 'leaderboard' : 'runs';
  return (
    <main className="page">
      <div className="page-head row">
        <h1>测试报告</h1>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'runs'} className={tab === 'runs' ? 'on' : ''} onClick={() => setParams({})}>测试记录</button>
          <button role="tab" aria-selected={tab === 'leaderboard'} className={tab === 'leaderboard' ? 'on' : ''} onClick={() => setParams({ tab: 'leaderboard' })}>排行榜</button>
        </div>
      </div>
      {tab === 'runs' ? <HistoryPage embedded /> : <LeaderboardPage embedded />}
    </main>
  );
}
