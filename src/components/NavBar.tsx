import { Link, NavLink, useLocation } from 'react-router-dom';
import { useTheme } from '../lib/theme.ts';
import BrandMark from './BrandMark.tsx';

/** 「竞技场」下的子页面，导航高亮时一并视为竞技场 */
export const ARENA_PATHS = ['/arena', '/providers', '/practice'];

export default function NavBar() {
  const { pathname } = useLocation();
  const [theme, toggleTheme] = useTheme();
  const inArena = ARENA_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    <header className="nav">
      <div className="nav-inner glass">
        <Link to="/" className="brand" aria-label="魔方智竞 首页">
          <BrandMark size={34} />
          <span>魔方智竞</span>
        </Link>
        <nav className="nav-links" aria-label="主导航">
          <NavLink to="/" end>首页</NavLink>
          <NavLink to="/arena" className={() => (inArena ? 'active' : '')}>竞技场</NavLink>
          <NavLink to="/reports">测试报告</NavLink>
        </nav>
        <div className="nav-actions">
          <button
            className={`theme-toggle ${theme}`}
            onClick={toggleTheme}
            role="switch"
            aria-checked={theme === 'dark'}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            title={theme === 'dark' ? '浅色模式' : '深色模式'}
          >
            <span className="tt-sun" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            </span>
            <span className="tt-moon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
              </svg>
            </span>
          </button>
          <Link to="/arena" className="btn dark nav-cta">
            开始测试 <span aria-hidden="true">→</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
