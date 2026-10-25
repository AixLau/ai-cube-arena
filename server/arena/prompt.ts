import { ALL_MOVES, correctStickers, stateToFaceList, stateToNet, type CubeState } from '../../shared/cube.ts';
import type { RunLimits } from '../../shared/types.ts';
import type { ToolSpec } from '../adapters/types.ts';

/** 魔方状态编码规范版本：所有参赛模型使用同一规范 */
export const STATE_ENCODING = 'facelet-net-v1';

export function rotateCubeTool(limits: RunLimits): ToolSpec {
  return {
    name: 'rotate_cube',
    description:
      `Rotate faces of the 3x3x3 cube. Executes the given moves in order and returns the new cube state. ` +
      `Allowed moves: R L U D F B (90° clockwise looking at that face), with ' for counter-clockwise and 2 for 180°. ` +
      `Any number of moves may be supplied in one call. If any move is invalid, the whole call is rejected and nothing is executed.`,
    parameters: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          description: `Moves to execute in order, e.g. ["R", "U'", "F2"].`,
          items: { type: 'string', enum: ALL_MOVES },
        },
      },
      required: ['moves'],
    },
  };
}

const ORDER_NAME: Record<number, string> = { 2: '二阶', 3: '三阶', 4: '四阶', 5: '五阶' };

/** 不同阶数的朝向说明：奇数阶中心固定；偶数阶没有固定中心 */
function orientationNote(n: number): string {
  if (n === 2) return '二阶魔方没有中心块，也不区分固定朝向：只要每个面颜色一致即视为复原，不要求某个颜色在某个面。';
  if (n === 4) return '只允许外层转动，因此每个面中央的 2×2 中心区块永不移动，可作为该面的目标颜色参照。';
  return '中心块永不移动，可作为该面的目标颜色参照。';
}

export function systemPrompt(limits: RunLimits, n: number = 3): string {
  const name = ORDER_NAME[n] ?? `${n} 阶`;
  const rows = Array.from({ length: n }, (_, i) => `第${i + 1}行`).join('/');
  return `你正在参加「AI 魔方能力评测」。你的任务：仅通过调用 rotate_cube 工具，把一个被打乱的${name}魔方（${n}×${n}×${n}）复原。

【评测规则】
- 你只能通过 rotate_cube 工具转动魔方；系统按顺序执行你提供的动作后返回新状态。
- 只要包含一个非法记号，整次调用会被拒绝且不执行任何转动。
- 评测不会因思考时间、调用次数或动作数量自动终止；魔方复原后立即结束。
- 魔方复原（每个面颜色一致）的瞬间评测立即结束，无需再回复。用尽量少的步数复原。

【坐标与配色】
- 复原态配色：U=上(白) D=下(黄) F=前(绿) B=后(蓝) R=右(红) L=左(橙)。${orientationNote(n)}
- 颜色字母：W白 Y黄 G绿 B蓝 R红 O橙。

【状态编码规范 ${STATE_ENCODING}】
- 每个面是 ${n}×${n} 的格子，按行优先（左上→右下）列出，格式「面: ${rows}」。
- F/R/B/L 面：正对该面观察，U 面在上方；U 面：从上往下看，F 面在下方；D 面：从下往上看，F 面在上方。
- 展开图：U 在上，中间一行依次为 L F R B，D 在下。

【转动记号】只允许 18 种外层转动：R L U D F B 表示正对该面把最外一层顺时针转 90°，加 ' 表示逆时针 90°，加 2 表示 180°。不允许 x/y/z、M/E/S、宽层（Rw / 小写）或内层转动。`;
}

export function describeState(state: CubeState): { net: string; faces: string; correct: number; total: number } {
  return { net: stateToNet(state), faces: stateToFaceList(state), correct: correctStickers(state), total: state.length };
}

export function initialUserMessage(state: CubeState): string {
  const s = describeState(state);
  return [
    '这是本局魔方的当前状态，请开始调用 rotate_cube 复原。',
    `已归位贴纸：${s.correct}/${s.total}`,
    '',
    '展开图：',
    s.net,
    '',
    '逐面格子：',
    s.faces,
  ].join('\n');
}

export const NO_TOOL_NUDGE = '请通过调用 rotate_cube 工具继续转动魔方，不要只回复文字。';
