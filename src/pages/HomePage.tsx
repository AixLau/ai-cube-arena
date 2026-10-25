import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { CUBE_SIZE_INFO, DIFFICULTIES } from '../../shared/types.ts';
import AutoSolveCube from '../components/AutoSolveCube.tsx';
import VendorIcon, { type Vendor } from '../components/BrandIcons.tsx';
import HeroCube from '../components/HeroCube.tsx';
import MiniCube from '../components/MiniCube.tsx';

interface ModelCard {
  vendor: Vendor;
  maker: string;
  name: string;
  tags: [string, string];
  /** 环绕位置（相对魔方区域的百分比）与视差深度 */
  pos: CSSProperties;
  depth: number;
  tilt: number;
}

const MODEL_CARDS: ModelCard[] = [
  { vendor: 'openai', maker: 'OpenAI', name: 'GPT-6 Astra', tags: ['复杂推理', '策略规划'], pos: { left: '2%', top: '4%' }, depth: 18, tilt: -2 },
  { vendor: 'anthropic', maker: 'Anthropic', name: 'Claude Opus 5.5', tags: ['深度推理', '智能决策'], pos: { right: '1%', top: '1%' }, depth: 24, tilt: 3 },
  { vendor: 'google', maker: 'Google DeepMind', name: 'Gemini 4 Argon', tags: ['高级推理', '长程规划'], pos: { left: '6%', top: '36%' }, depth: 12, tilt: -3 },
  { vendor: 'qwen', maker: 'Alibaba Qwen', name: 'Qwen3.8-Max', tags: ['逻辑推理', '复杂任务'], pos: { right: '-2%', top: '30%' }, depth: 16, tilt: 4 },
  { vendor: 'deepseek', maker: 'DeepSeek', name: 'DeepSeek V4.1 Flash', tags: ['高效推理', '快速决策'], pos: { left: '4%', top: '70%' }, depth: 22, tilt: -4 },
  { vendor: 'more', maker: '更多模型', name: 'More Models', tags: ['持续扩展', '自由接入'], pos: { right: '4%', top: '64%' }, depth: 10, tilt: 3 },
];

const HIGHLIGHTS = [
  { icon: 'link', title: '多模型接入', desc: '兼容不同 AI 服务商\n及自定义模型' },
  { icon: 'cube', title: '多阶魔方挑战', desc: '支持 2×2、3×3、4×4、5×5\n等难度模式' },
  { icon: 'users', title: '多模型同步竞技', desc: '在统一初始状态下对比\n不同模型的求解策略' },
  { icon: 'chart', title: '过程实时可视化', desc: '直观展示模型决策、\n旋转步骤与复原进度' },
] as const;

function HighlightIcon({ name }: { name: (typeof HIGHLIGHTS)[number]['icon'] }) {
  const common = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (name === 'link') return <svg {...common}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>;
  if (name === 'cube') return <svg {...common}><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Z" /><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" /></svg>;
  if (name === 'users') return <svg {...common} fill="currentColor" stroke="none"><circle cx="9" cy="8" r="3.5" /><circle cx="17" cy="9" r="2.8" /><path d="M2 19c0-3.6 3.1-6 7-6s7 2.4 7 6v1H2zM16.5 13.2c3 .3 5.5 2.3 5.5 5.3v1.5h-4v-1c0-2.3-.6-4.2-1.5-5.8z" /></svg>;
  return <svg {...common} fill="currentColor" stroke="none"><rect x="3" y="12" width="3.6" height="8" rx="1" /><rect x="8.6" y="8" width="3.6" height="12" rx="1" /><rect x="14.2" y="4" width="3.6" height="16" rx="1" /><rect x="19.4" y="10" width="2.4" height="10" rx="1" /></svg>;
}

const PROVIDERS: { vendor: Vendor; name: string; connected: boolean }[] = [
  { vendor: 'openai', name: 'OpenAI', connected: true },
  { vendor: 'anthropic', name: 'Anthropic', connected: true },
  { vendor: 'google', name: 'Google', connected: true },
  { vendor: 'deepseek', name: 'DeepSeek', connected: false },
];

const PICKABLE: { vendor: Vendor; name: string; tags: [string, string] }[] = [
  { vendor: 'openai', name: 'GPT-6 Astra', tags: ['复杂推理', '策略规划'] },
  { vendor: 'anthropic', name: 'Claude Opus 5.5', tags: ['深度推理', '智能决策'] },
  { vendor: 'google', name: 'Gemini 4 Argon', tags: ['高级推理', '长程规划'] },
  { vendor: 'deepseek', name: 'DeepSeek V4.1', tags: ['高效推理', '快速决策'] },
  { vendor: 'qwen', name: 'Qwen3.8-Max', tags: ['逻辑推理', '复杂任务'] },
];

function Chevron() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
}

/** 第 4 步卡片中的求解演示：真实魔方 + 当前步骤高亮 */
function SolvePreview({ size }: { size: number }) {
  const [p, setP] = useState({ step: 0, total: 1, moves: [] as string[] });
  const start = Math.max(0, Math.min(p.step - 3, p.moves.length - 7));
  const windowMoves = p.moves.slice(start, start + 7);
  return (
    <div className="solve-preview">
      <AutoSolveCube key={size} size={size} scrambleLength={10} intervalMs={1100} className="sp-cube auto-solve" onProgress={(step, total, moves) => setP({ step, total, moves })} />
      <div className="sp-status">
        <div className="sp-line"><span className="live-dot" />求解进行中</div>
        <div className="sp-step num">步骤 {p.step} / {p.total}</div>
        <div className="sp-bar"><div style={{ width: `${(p.step / p.total) * 100}%` }} /></div>
        <span className="sp-pct num">{Math.round((p.step / p.total) * 100)}%</span>
      </div>
      <div className="sp-moves" aria-label="旋转指令序列">
        {windowMoves.map((m, i) => (
          <span key={start + i} className={start + i === p.step - 1 ? 'on' : start + i < p.step ? 'done' : ''}>{m}</span>
        ))}
      </div>
    </div>
  );
}

function DemoModal({ onClose }: { onClose(): void }) {
  const [p, setP] = useState({ step: 0, total: 1 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="glass strong modal demo-modal" role="dialog" aria-modal="true" aria-label="观看演示">
        <header className="modal-head">
          <h2>竞技演示</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="demo-body">
          <AutoSolveCube size={3} scrambleLength={14} intervalMs={750} className="demo-cube auto-solve" onProgress={(step, total) => setP({ step, total })} />
          <div className="demo-meta">
            <span className="live-dot" /> 模型正在调用 rotate_cube · 步骤 {p.step} / {p.total}
          </div>
          <div className="sp-bar"><div style={{ width: `${(p.step / p.total) * 100}%` }} /></div>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const visual = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(3);
  const [level, setLevel] = useState(1);
  const [picked, setPicked] = useState<string[]>(['GPT-6 Astra', 'Claude Opus 5.5', 'Gemini 4 Argon']);
  const [demo, setDemo] = useState(false);

  // 模型卡片随鼠标轻微视差
  const onMove = (e: React.MouseEvent) => {
    const el = visual.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    el.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  };
  const onLeave = () => {
    visual.current?.style.setProperty('--px', '0');
    visual.current?.style.setProperty('--py', '0');
  };

  const difficulty = DIFFICULTIES[level];
  const arenaLink = `/arena?size=${size}&difficulty=${difficulty.id}`;

  return (
    <main className="home">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">RUBIK AI ARENA</p>
          <h1>
            让顶尖的 AI
            <br />
            在魔方上相遇
          </h1>
          <p className="hero-sub">
            连接你偏好的 AI 模型，观察不同 AI 的推理策略，
            <br className="br-wide" />
            在同一块魔方上展开一场真正的智力竞技。
          </p>
          <div className="hero-cta">
            <Link to="/arena" className="btn dark lg">
              立即开始竞技 <span aria-hidden="true">→</span>
            </Link>
            <button className="btn glassy lg" onClick={() => setDemo(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" /></svg>
              观看演示
            </button>
          </div>
        </div>

        <div className="hero-visual" ref={visual} onMouseMove={onMove} onMouseLeave={onLeave}>
          <HeroCube />
          <div className="model-orbit">
            {MODEL_CARDS.map((m) => (
              <div
                key={m.name}
                className={`model-card glass vendor-${m.vendor}`}
                style={{ ...m.pos, '--depth': m.depth, '--tilt': `${m.tilt}deg` } as CSSProperties}
              >
                <span className="mc-icon"><VendorIcon vendor={m.vendor} size={26} /></span>
                <span className="mc-text">
                  <small>{m.maker}</small>
                  <b>{m.name}</b>
                  <span className="mc-tags">
                    {m.tags.map((t) => <em key={t}>{t}</em>)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="highlights" aria-label="平台核心优势">
        {HIGHLIGHTS.map((h) => (
          <div key={h.title} className="hl">
            <span className="hl-icon"><HighlightIcon name={h.icon} /></span>
            <span>
              <b>{h.title}</b>
              <small>{h.desc}</small>
            </span>
          </div>
        ))}
      </section>

      <section className="steps" aria-label="开始使用">
        <article className="step glass">
          <span className="step-no">01</span>
          <h3>接入你的 AI 模型</h3>
          <p>配置模型服务商的 API Key，自动同步并加载可用模型，快速完成竞技环境接入。</p>
          <ul className="prov-list">
            {PROVIDERS.map((p) => (
              <li key={p.name}>
                <span className={`vi vendor-${p.vendor}`}><VendorIcon vendor={p.vendor} size={18} /></span>
                <span className="pl-name">{p.name}</span>
                <span className={`pl-status ${p.connected ? 'on' : ''}`}>{p.connected ? '已连接' : '未配置'}</span>
              </li>
            ))}
          </ul>
          <Link to="/providers" className="step-action">
            <span>＋</span> 添加自定义供应商 <Chevron />
          </Link>
        </article>

        <article className="step glass">
          <span className="step-no">02</span>
          <h3>选择魔方难度</h3>
          <p>从入门到专业，选择不同阶数的魔方挑战，检验 AI 模型在不同问题复杂度下的求解能力。</p>
          <div className="size-cards" role="radiogroup" aria-label="魔方阶数">
            {CUBE_SIZE_INFO.map((c) => (
              <button key={c.n} role="radio" aria-checked={size === c.n} className={size === c.n ? 'on' : ''} onClick={() => setSize(c.n)}>
                <MiniCube n={c.n} size={46} />
                <b>{c.name}</b>
                <small>{c.level}</small>
              </button>
            ))}
          </div>
          <div className="level">
            <input
              type="range"
              min={0}
              max={DIFFICULTIES.length - 1}
              step={1}
              value={level}
              onChange={(e) => setLevel(+e.target.value)}
              aria-label="打乱程度"
              aria-valuetext={difficulty.name}
              style={{ '--fill': `${(level / (DIFFICULTIES.length - 1)) * 100}%` } as CSSProperties}
            />
            <div className="level-labels">
              <span>简单<small>更快求解</small></span>
              <span className="level-now">{difficulty.name}</span>
              <span>复杂<small>更强推理</small></span>
            </div>
          </div>
        </article>

        <article className="step glass">
          <span className="step-no">03</span>
          <h3>选择竞技模型</h3>
          <p>自由选择多个 AI 模型参与同场竞技，在相同初始条件下比较不同模型的推理效率与求解策略。</p>
          <ul className="pick-list">
            {PICKABLE.map((m) => {
              const on = picked.includes(m.name);
              return (
                <li key={m.name} className={on ? 'on' : ''}>
                  <label>
                    <input type="checkbox" checked={on} onChange={() => setPicked((s) => (on ? s.filter((x) => x !== m.name) : [...s, m.name]))} />
                    <span className={`vi vendor-${m.vendor}`}><VendorIcon vendor={m.vendor} size={18} /></span>
                    <span className="pk-name">{m.name}</span>
                    <span className="pk-tags">{m.tags.map((t) => <em key={t}>{t}</em>)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <Link to="/providers" className="step-action">
            <span>＋</span> 添加更多模型 <Chevron />
          </Link>
        </article>

        <article className="step glass">
          <span className="step-no">04</span>
          <h3>开始魔方竞技</h3>
          <p>基于统一的魔方初始状态，启动多模型并行求解，实时追踪每一步旋转操作、策略输出与复原进度。</p>
          <SolvePreview size={size} />
          <Link to={arenaLink} className="btn dark block step-go">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Z" /><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" /></svg>
            开始竞技 <span aria-hidden="true">→</span>
          </Link>
        </article>
      </section>

      {demo && <DemoModal onClose={() => setDemo(false)} />}
    </main>
  );
}
