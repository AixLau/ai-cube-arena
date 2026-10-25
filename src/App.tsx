import { Route, Routes, useLocation } from 'react-router-dom';
import ArenaTabs from './components/ArenaTabs.tsx';
import Backdrop from './components/Backdrop.tsx';
import NavBar, { ARENA_PATHS } from './components/NavBar.tsx';
import ArenaPage from './pages/ArenaPage.tsx';
import HistoryPage from './pages/HistoryPage.tsx';
import HomePage from './pages/HomePage.tsx';
import LeaderboardPage from './pages/LeaderboardPage.tsx';
import PracticePage from './pages/PracticePage.tsx';
import ProvidersPage from './pages/ProvidersPage.tsx';
import RunDetailPage from './pages/RunDetailPage.tsx';

export default function App() {
  const { pathname } = useLocation();
  const inArena = ARENA_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return (
    <>
      <Backdrop />
      <NavBar />
      {inArena && <ArenaTabs />}
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/arena" element={<ArenaPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/history/:id" element={<RunDetailPage />} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="/practice" element={<PracticePage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </>
  );
}
