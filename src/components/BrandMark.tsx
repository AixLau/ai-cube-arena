type Pt = [number, number];

// 等轴测立方体的 7 个可见顶点（viewBox 64×64）
const T: Pt = [32, 6];
const UL: Pt = [9.5, 19];
const UR: Pt = [54.5, 19];
const C: Pt = [32, 32];
const LL: Pt = [9.5, 45];
const LR: Pt = [54.5, 45];
const B: Pt = [32, 58];

/** 由原点和两条边向量参数化一个面：P(u, v) = o + u·e1 + v·e2 */
function face(o: Pt, p1: Pt, p2: Pt) {
  const e1: Pt = [p1[0] - o[0], p1[1] - o[1]];
  const e2: Pt = [p2[0] - o[0], p2[1] - o[1]];
  const at = (u: number, v: number): Pt => [o[0] + u * e1[0] + v * e2[0], o[1] + u * e1[1] + v * e2[1]];
  const gap = 0.045;
  const cells: string[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const u0 = i / 3 + gap, u1 = (i + 1) / 3 - gap, v0 = j / 3 + gap, v1 = (j + 1) / 3 - gap;
      cells.push([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)].map((p) => p.map((n) => n.toFixed(2)).join(',')).join(' '));
    }
  }
  return cells;
}

const TOP = face(T, UR, UL);
const LEFT = face(UL, C, LL);
const RIGHT = face(C, UR, B);

/** 品牌标识：等轴测视角的立体魔方，三个可见面以蓝紫渐变区分明暗 */
export default function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="brand-mark">
      <defs>
        <linearGradient id="bm-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d6f1ff" />
          <stop offset="1" stopColor="#62b8f5" />
        </linearGradient>
        <linearGradient id="bm-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3f93f2" />
          <stop offset="1" stopColor="#1a4fc4" />
        </linearGradient>
        <linearGradient id="bm-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8a7bf5" />
          <stop offset="1" stopColor="#3b3ab8" />
        </linearGradient>
      </defs>
      <g fill="url(#bm-top)">{TOP.map((p) => <polygon key={p} points={p} />)}</g>
      <g fill="url(#bm-left)">{LEFT.map((p) => <polygon key={p} points={p} />)}</g>
      <g fill="url(#bm-right)">{RIGHT.map((p) => <polygon key={p} points={p} />)}</g>
    </svg>
  );
}
