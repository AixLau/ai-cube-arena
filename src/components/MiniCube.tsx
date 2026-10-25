type Pt = [number, number];

const T: Pt = [32, 6];
const UL: Pt = [9.5, 19];
const UR: Pt = [54.5, 19];
const C: Pt = [32, 32];
const LL: Pt = [9.5, 45];
const B: Pt = [32, 58];

const COLORS = ['#2f6bff', '#f3f7ff', '#ff8757', '#e5484d', '#2f6bff', '#f3f7ff'];

function cells(o: Pt, p1: Pt, p2: Pt, n: number, seed: number) {
  const e1: Pt = [p1[0] - o[0], p1[1] - o[1]];
  const e2: Pt = [p2[0] - o[0], p2[1] - o[1]];
  const at = (u: number, v: number): Pt => [o[0] + u * e1[0] + v * e2[0], o[1] + u * e1[1] + v * e2[1]];
  const gap = 0.12 / n;
  const out: { points: string; fill: string }[] = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const u0 = i / n + gap, u1 = (i + 1) / n - gap, v0 = j / n + gap, v1 = (j + 1) / n - gap;
      out.push({
        points: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)].map((p) => p.map((x) => x.toFixed(2)).join(',')).join(' '),
        fill: COLORS[s % COLORS.length],
      });
    }
  }
  return out;
}

/** 等轴测的 N 阶小魔方（打乱配色），用于难度选择 */
export default function MiniCube({ n, size = 56 }: { n: number; size?: number }) {
  const faces = [
    { cells: cells(T, UR, UL, n, 11 * n), shade: 1 },
    { cells: cells(UL, C, LL, n, 23 * n), shade: 0.82 },
    { cells: cells(C, UR, B, n, 37 * n), shade: 0.68 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="mini-cube">
      <path d="M32 6 54.5 19v26L32 58 9.5 45V19Z" fill="#141b2b" />
      {faces.map((f, i) => (
        <g key={i} style={{ filter: `brightness(${f.shade})` }}>
          {f.cells.map((c) => <polygon key={c.points} points={c.points} fill={c.fill} />)}
        </g>
      ))}
    </svg>
  );
}
