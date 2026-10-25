import { NavLink } from 'react-router-dom';

/** 竞技场下的子导航 */
export default function ArenaTabs() {
  return (
    <nav className="arena-tabs" aria-label="竞技场">
      <NavLink to="/arena">竞技场</NavLink>
      <NavLink to="/providers">模型配置</NavLink>
      <NavLink to="/history">历史回放</NavLink>
      <NavLink to="/practice">自由练习</NavLink>
    </nav>
  );
}
