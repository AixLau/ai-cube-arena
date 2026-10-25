/**
 * 独立的 N 阶魔方状态引擎（前后端共用，支持 2～5 阶）。
 *
 * 状态用 6×N×N 个贴纸表示，面顺序为 U R F D L B，每面按标准展开图行优先排列：
 *   U：俯视，F 在下方；D：仰视，F 在上方；
 *   F/R/B/L：正视该面，U 在上方。
 * 每个贴纸的值是它当前颜色所属的面（即该颜色在复原态下所在的面）。
 * 只支持外层转动（R L U D F B 及其 ' 与 2），转动置换由三维坐标旋转推导生成，
 * 因此所有状态都是合法可达状态；阶数由状态长度推导。
 */

export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'] as const;
export type Face = (typeof FACES)[number];
export type Amount = 1 | 2 | -1;
export interface Move {
  face: Face;
  amount: Amount;
}
export type CubeState = Face[];

export const CUBE_SIZES = [2, 3, 4, 5] as const;
export type CubeSize = (typeof CUBE_SIZES)[number];

type Vec = [number, number, number];

const FACE_NORMAL: Record<Face, Vec> = {
  U: [0, 1, 0],
  R: [1, 0, 0],
  F: [0, 0, 1],
  D: [0, -1, 0],
  L: [-1, 0, 0],
  B: [0, 0, -1],
};

/**
 * 坐标取 -(N-1), -(N-3), …, N-1（即 2 倍的格子中心坐标，保证为整数）。
 * 由贴纸所在面与坐标得到展开图中的行列。
 */
function rowCol(face: Face, [x, y, z]: Vec, k: number): [number, number] {
  const fwd = (v: number) => (v + k) / 2;
  const rev = (v: number) => (k - v) / 2;
  switch (face) {
    case 'U': return [fwd(z), fwd(x)];
    case 'D': return [rev(z), fwd(x)];
    case 'F': return [rev(y), fwd(x)];
    case 'B': return [rev(y), rev(x)];
    case 'R': return [rev(y), rev(z)];
    case 'L': return [rev(y), fwd(z)];
  }
}

function faceOfNormal(n: Vec): Face {
  return FACES.find((f) => FACE_NORMAL[f].every((v, i) => v === n[i]))!;
}

/** 绕坐标轴（0=x,1=y,2=z）按右手定则旋转 +90° 一次 */
function rotateCCW(v: Vec, axis: number): Vec {
  const [x, y, z] = v;
  if (axis === 0) return [x, -z, y];
  if (axis === 1) return [z, y, -x];
  return [-y, x, z];
}

interface Geometry {
  n: number;
  /** 每个面外层顺时针四分之一转的置换：next[perm[i]] = cur[i] */
  quarter: Record<Face, number[]>;
}

const geometries = new Map<number, Geometry>();

function geometry(n: number): Geometry {
  const cached = geometries.get(n);
  if (cached) return cached;
  const k = n - 1;
  const per = n * n;
  const indexOf = (pos: Vec, normal: Vec) => {
    const face = faceOfNormal(normal);
    const [r, c] = rowCol(face, pos, k);
    return FACES.indexOf(face) * per + r * n + c;
  };
  const stickers: { pos: Vec; normal: Vec }[] = new Array(6 * per);
  const coords = Array.from({ length: n }, (_, i) => -k + 2 * i);
  for (const face of FACES) {
    const normal = FACE_NORMAL[face];
    const axis = normal.findIndex((v) => v !== 0);
    const others = [0, 1, 2].filter((i) => i !== axis);
    for (const a of coords) {
      for (const b of coords) {
        const pos = [0, 0, 0] as Vec;
        pos[axis] = normal[axis] * k;
        pos[others[0]] = a;
        pos[others[1]] = b;
        stickers[indexOf(pos, normal)] = { pos, normal: [...normal] as Vec };
      }
    }
  }
  const quarter = {} as Record<Face, number[]>;
  for (const face of FACES) {
    const normal = FACE_NORMAL[face];
    const axis = normal.findIndex((v) => v !== 0);
    const sign = normal[axis];
    // 从面外看顺时针 = 绕外法线负向旋转 90°；对负方向的面等价于绕正轴 +90°
    const ccwTurns = sign > 0 ? 3 : 1;
    quarter[face] = stickers.map((s, i) => {
      if (s.pos[axis] !== sign * k) return i;
      let p = s.pos;
      let nm = s.normal;
      for (let t = 0; t < ccwTurns; t++) {
        p = rotateCCW(p, axis);
        nm = rotateCCW(nm, axis);
      }
      return indexOf(p, nm);
    });
  }
  const g = { n, quarter };
  geometries.set(n, g);
  return g;
}

export function sizeOf(state: CubeState): number {
  return Math.round(Math.sqrt(state.length / 6));
}

export function solvedState(n: number = 3): CubeState {
  return FACES.flatMap((f) => Array<Face>(n * n).fill(f));
}

export function applyMove(state: CubeState, move: Move): CubeState {
  const perm = geometry(sizeOf(state)).quarter[move.face];
  const times = move.amount === 1 ? 1 : move.amount === 2 ? 2 : 3;
  let cur = state;
  for (let t = 0; t < times; t++) {
    const next = new Array<Face>(cur.length);
    for (let i = 0; i < cur.length; i++) next[perm[i]] = cur[i];
    cur = next;
  }
  return cur;
}

export function applyMoves(state: CubeState, moves: Move[]): CubeState {
  return moves.reduce(applyMove, state);
}

function faceStickers(state: CubeState, f: number): Face[] {
  const per = sizeOf(state) ** 2;
  return state.slice(f * per, f * per + per);
}

/** 复原 = 每个面颜色一致（偶数阶没有固定中心，不要求与某个颜色对应） */
export function isSolved(state: CubeState): boolean {
  for (let f = 0; f < 6; f++) {
    const s = faceStickers(state, f);
    if (s.some((x) => x !== s[0])) return false;
  }
  return true;
}

const MOVE_RE = /^([URFDLB])(2|'|’)?$/;

export function parseMove(token: string): Move | null {
  const m = MOVE_RE.exec(token.trim().replace(/2'$/, '2'));
  if (!m) return null;
  const amount: Amount = m[2] === '2' ? 2 : m[2] ? -1 : 1;
  return { face: m[1] as Face, amount };
}

export function formatMove(move: Move): string {
  return move.face + (move.amount === 2 ? '2' : move.amount === -1 ? "'" : '');
}

export function parseAlg(alg: string): Move[] {
  return alg
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const m = parseMove(t);
      if (!m) throw new Error(`非法转动：${t}`);
      return m;
    });
}

export function formatAlg(moves: Move[]): string {
  return moves.map(formatMove).join(' ');
}

export function invertMove(move: Move): Move {
  return { face: move.face, amount: move.amount === 2 ? 2 : ((-move.amount) as Amount) };
}

export function invertAlg(moves: Move[]): Move[] {
  return [...moves].reverse().map(invertMove);
}

/** 全部 18 种基本转动 */
export const ALL_MOVES: string[] = FACES.flatMap((f) => [f, `${f}'`, `${f}2`]);

/** 四分之一转计数（QTM）：180° 记 2 次 */
export function quarterTurns(move: Move): number {
  return move.amount === 2 ? 2 : 1;
}

const AXIS: Record<Face, number> = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };

/** 随机打乱：不连续转同一面，且不出现同轴三连；打乱结果一定不是复原态 */
export function randomScramble(length: number, rand: () => number = Math.random, n: number = 3): Move[] {
  for (;;) {
    const moves: Move[] = [];
    while (moves.length < length) {
      const face = FACES[Math.floor(rand() * 6)];
      const last = moves[moves.length - 1];
      const prev = moves[moves.length - 2];
      if (last && last.face === face) continue;
      if (last && prev && AXIS[last.face] === AXIS[face] && AXIS[prev.face] === AXIS[face]) continue;
      moves.push({ face, amount: ([1, 2, -1] as Amount[])[Math.floor(rand() * 3)] });
    }
    // 二阶的对面转动可能整体等价于转体，需整体检查
    if (!isSolved(applyMoves(solvedState(n), moves))) return moves;
  }
}

/** 面名 → 颜色（与 cubing.js 默认配色一致） */
export const FACE_COLOR_NAME: Record<Face, string> = {
  U: '白', R: '红', F: '绿', D: '黄', L: '橙', B: '蓝',
};
const FACE_COLOR_LETTER: Record<Face, string> = {
  U: 'W', R: 'R', F: 'G', D: 'Y', L: 'O', B: 'B',
};

/** 将状态渲染为展开图文本（供大模型阅读） */
export function stateToNet(state: CubeState): string {
  const n = sizeOf(state);
  const row = (f: Face, r: number) =>
    Array.from({ length: n }, (_, c) => FACE_COLOR_LETTER[state[FACES.indexOf(f) * n * n + r * n + c]]).join(' ');
  const pad = ' '.repeat(2 * n + 2);
  const lines: string[] = [];
  for (let r = 0; r < n; r++) lines.push(pad + row('U', r));
  for (let r = 0; r < n; r++) lines.push(['L', 'F', 'R', 'B'].map((f) => row(f as Face, r)).join('   '));
  for (let r = 0; r < n; r++) lines.push(pad + row('D', r));
  return lines.join('\n');
}

/** 按面列出九宫格（行优先，行之间用 / 分隔） */
export function stateToFaceList(state: CubeState): string {
  const n = sizeOf(state);
  return FACES.map((f, fi) => {
    const cells = faceStickers(state, fi).map((x) => FACE_COLOR_LETTER[x]);
    const rows = Array.from({ length: n }, (_, r) => cells.slice(r * n, r * n + n).join(''));
    return `${f}: ${rows.join('/')}`;
  }).join('\n');
}

/**
 * 已归位贴纸数量，用于衡量进度：
 * 奇数阶与所在面中心同色；偶数阶没有固定中心，按每面出现最多的颜色计。
 */
export function correctStickers(state: CubeState): number {
  const n = sizeOf(state);
  let total = 0;
  for (let f = 0; f < 6; f++) {
    const s = faceStickers(state, f);
    if (n % 2 === 1) {
      const center = s[(s.length - 1) / 2];
      total += s.filter((x) => x === center).length;
    } else {
      const counts = new Map<Face, number>();
      for (const x of s) counts.set(x, (counts.get(x) ?? 0) + 1);
      total += Math.max(...counts.values());
    }
  }
  return total;
}

export function stickerCount(n: number): number {
  return 6 * n * n;
}
