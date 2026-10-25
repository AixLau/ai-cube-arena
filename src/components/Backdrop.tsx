import { useEffect, useRef } from 'react';

/** 蓝调波光背景：渐变 + 虹彩光斑 + 沿对角线分布的闪烁亮片 */
export default function Backdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let raf = 0;
    type P = { x: number; y: number; r: number; phase: number; speed: number; hue: number };
    let parts: P[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(260, (w * h) / 6000));
      parts = Array.from({ length: count }, () => {
        // 沿右上→左下的对角光带分布，带高斯式散布
        const t = Math.random();
        const spread = (Math.random() + Math.random() + Math.random() - 1.5) * 0.35;
        return {
          x: w * (0.95 - t * 0.9) + spread * w * 0.5,
          y: h * (t * 1.05 - 0.05) + spread * h * 0.3,
          r: Math.random() < 0.08 ? 1.6 + Math.random() * 2.2 : 0.4 + Math.random() * 1.1,
          phase: Math.random() * Math.PI * 2,
          speed: 0.6 + Math.random() * 1.8,
          hue: Math.random() < 0.25 ? 20 + Math.random() * 300 : -1,
        };
      });
    };

    const draw = (time: number) => {
      ctx.clearRect(0, 0, w, h);
      // 浅色背景上白色亮片不可见，改用淡蓝色
      const dark = document.documentElement.dataset.theme === 'dark';
      for (const p of parts) {
        const a = reduce ? 0.6 : 0.25 + 0.75 * Math.abs(Math.sin(p.phase + (time / 1000) * p.speed));
        ctx.beginPath();
        ctx.fillStyle = dark || p.hue >= 0 ? (p.hue < 0 ? `rgba(255,255,255,${a})` : `hsla(${p.hue},100%,${dark ? 88 : 72}%,${a})`) : `rgba(110,150,240,${a * 0.55})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        if (p.r > 1.5) {
          ctx.fillStyle = `rgba(255,255,255,${a * 0.18})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    resize();
    raf = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="backdrop" aria-hidden>
      <div className="streak" />
      <div className="flare f1" />
      <div className="flare f2" />
      <div className="flare f3" />
      <canvas ref={canvasRef} />
    </div>
  );
}
