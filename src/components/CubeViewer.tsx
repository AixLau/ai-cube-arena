import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { TwistyPlayer } from 'cubing/twisty';

export interface CubeViewerHandle {
  /** 以给定打乱为初始状态，清空已执行的转动 */
  reset(setupAlg: string): void;
  /** 追加一步转动，带真实的层旋转动画 */
  addMove(move: string): void;
  /** 直接跳到「打乱 + 给定转动」后的状态，不播放动画（用于回放跳转、追赶积压） */
  jumpTo(alg: string): void;
}

interface Props {
  tempoScale?: number;
  /** 是否在魔方外侧悬浮显示被遮挡面的贴纸（仅影响渲染，不改变魔方状态） */
  showHiddenFaces?: boolean;
  /** 初始打乱（创建时生效，之后用 reset 修改） */
  setupAlg?: string;
  /** 魔方阶数（2～5），创建时生效 */
  size?: number;
}

const hintMode = (show: boolean) => (show ? 'floating' : 'none');

/** 基于 cubing.js TwistyPlayer 的 3D 魔方，支持鼠标 / 触屏拖拽旋转视角 */
const CubeViewer = forwardRef<CubeViewerHandle, Props>(function CubeViewer({ tempoScale = 1, showHiddenFaces = false, setupAlg = '', size = 3 }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<TwistyPlayer | null>(null);

  useEffect(() => {
    const player = new TwistyPlayer({
      puzzle: `${size}x${size}x${size}` as '3x3x3',
      visualization: 'PG3D',
      background: 'none',
      controlPanel: 'none',
      hintFacelets: hintMode(showHiddenFaces),
      backView: 'none',
      experimentalDragInput: 'auto',
      cameraLatitude: 28,
      cameraLongitude: 32,
      tempoScale,
      experimentalSetupAlg: setupAlg,
    });
    hostRef.current!.appendChild(player);
    playerRef.current = player;
    // 3D 模型异步加载完成后不一定会重绘首帧（页面布局若无变化就一直空白），这里显式触发一次
    let disposed = false;
    player
      .experimentalCurrentThreeJSPuzzleObject()
      .then(() => player.experimentalCurrentVantages())
      .then((vantages) => {
        if (!disposed) for (const v of vantages) v.scheduleRender();
      })
      .catch(() => {});
    return () => {
      disposed = true;
      player.remove();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (playerRef.current) playerRef.current.tempoScale = tempoScale;
  }, [tempoScale]);

  useEffect(() => {
    if (playerRef.current) playerRef.current.hintFacelets = hintMode(showHiddenFaces);
  }, [showHiddenFaces]);

  useImperativeHandle(ref, () => ({
    reset(setupAlg: string) {
      const p = playerRef.current;
      if (!p) return;
      p.experimentalSetupAlg = setupAlg;
      p.alg = '';
    },
    addMove(move: string) {
      playerRef.current?.experimentalAddMove(move, { cancel: false });
    },
    jumpTo(alg: string) {
      const p = playerRef.current;
      if (!p) return;
      p.alg = alg;
      p.jumpToEnd({ flash: false });
    },
  }));

  return <div className="stage-cube" ref={hostRef} />;
});

export default CubeViewer;
