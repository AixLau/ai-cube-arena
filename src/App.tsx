import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import Backdrop from './components/Backdrop.tsx';
import NavBar from './components/NavBar.tsx';
import ArenaPage from './pages/ArenaPage.tsx';
import HomePage from './pages/HomePage.tsx';
import PracticePage from './pages/PracticePage.tsx';
import ProvidersPage from './pages/ProvidersPage.tsx';
import ReportsPage from './pages/ReportsPage.tsx';
import RunDetailPage from './pages/RunDetailPage.tsx';

function LegacyRun() {
  const { id } = useParams();
  return <Navigate to={`/reports/${id}`} replace />;
}

export default function App() {
  return (
    <>
      <Backdrop />
      <NavBar />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/arena" element={<ArenaPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/reports/:id" element={<RunDetailPage />} />
        <Route path="/practice" element={<PracticePage />} />
        {/* 旧地址兼容 */}
        <Route path="/history" element={<Navigate to="/reports" replace />} />
        <Route path="/history/:id" element={<LegacyRun />} />
        <Route path="/leaderboard" element={<Navigate to="/reports?tab=leaderboard" replace />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </>
  );
}
