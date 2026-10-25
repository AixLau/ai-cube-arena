import { useEffect, useRef, useState } from 'react';
import { formatAlg, invertAlg, randomScramble } from '../../shared/cube.ts';
import CubeViewer, { type CubeViewerHandle } from './CubeViewer.tsx';

interface Props {
  size?: number;
  scrambleLength?: number;
  intervalMs?: number;
  /** 进度回调：当前步、总步数、全部步骤 */
  onProgress?(step: number, total: number, moves: string[]): void;
  className?: string;
}

/** 自动演示：随机打乱后逐步执行复原转动（真实的层旋转动画），结束后换一个打乱循环播放 */
export default function AutoSolveCube({ size = 3, scrambleLength = 12, intervalMs = 900, onProgress, className }: Props) {
  const viewer = useRef<CubeViewerHandle>(null);
  const [round, setRound] = useState(() => makeRound(size, scrambleLength));
  const progress = useRef(onProgress);
  progress.current = onProgress;

  useEffect(() => {
    viewer.current?.reset(round.scramble);
    progress.current?.(0, round.solution.length, round.solution);
    let step = 0;
    let timer = window.setTimeout(function tick() {
      if (step < round.solution.length) {
        viewer.current?.addMove(round.solution[step]);
        step++;
        progress.current?.(step, round.solution.length, round.solution);
        timer = window.setTimeout(tick, intervalMs);
      } else {
        timer = window.setTimeout(() => setRound(makeRound(size, scrambleLength)), 1600);
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [round, size, scrambleLength, intervalMs]);

  return (
    <div className={className}>
      <CubeViewer ref={viewer} size={size} setupAlg={round.scramble} tempoScale={1.6} />
    </div>
  );
}

function makeRound(size: number, length: number) {
  const s = randomScramble(length, Math.random, size);
  return { scramble: formatAlg(s), solution: invertAlg(s).map((m) => formatAlg([m])) };
}
