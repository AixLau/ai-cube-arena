import type { Face } from '../../shared/cube.ts';

const FACE_HEX: Record<Face, string> = {
  U: '#ffffff', R: '#e8303f', F: '#22b14c', D: '#ffd500', L: '#ff8a1f', B: '#1e63d6',
};
const FACE_NAME: Record<Face, string> = { U: '上', R: '右', F: '前', D: '下', L: '左', B: '后' };

interface Props {
  onMove(move: string): void;
  disabled?: boolean;
}

/** 18 种基本转动：每列一个面，依次为顺时针、逆时针、180° */
export default function MovePad({ onMove, disabled }: Props) {
  const order: Face[] = ['R', 'L', 'U', 'D', 'F', 'B'];
  return (
    <div className="movepad" role="group" aria-label="转动按键">
      {order.map((f) => (
        <div key={f} className="col-head">
          {f} · {FACE_NAME[f]}
        </div>
      ))}
      {['', "'", '2'].map((suffix) =>
        order.map((f) => (
          <button
            key={f + suffix}
            disabled={disabled}
            style={{ ['--face-color' as string]: f === 'U' ? '#cfd8e3' : FACE_HEX[f] }}
            title={`${FACE_NAME[f]}面${suffix === '' ? '顺时针 90°' : suffix === "'" ? '逆时针 90°' : '180°'}`}
            onClick={() => onMove(f + suffix)}
          >
            {f + suffix}
          </button>
        )),
      )}
    </div>
  );
}

