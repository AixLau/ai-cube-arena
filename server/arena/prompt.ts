import { ALL_MOVES, correctStickers, stateToFaceList, stateToNet, type CubeState } from '../../shared/cube.ts';
import type { RunLimits } from '../../shared/types.ts';
import type { ToolSpec } from '../adapters/types.ts';

/** 魔方状态编码规范版本：所有参赛模型使用同一规范 */
export const STATE_ENCODING = 'facelet-net-v1';

/**
 * 建议的单次动作数：不强制。已确定的公式应尽量一次提交，减少昂贵的
 * 往返请求；只有在动作依赖新状态或仍不确定时才拆成小段。
 */
export const SUGGESTED_MOVES_PER_CALL = 20;

/**
 * 每轮只回放上一轮协议所需的 assistant/tool 交互，并附上当前状态、最近几次调用
 * 的事实和模型自己记下的计划；上下文长度保持固定。系统不评价进展好坏，由模型根据状态自行判断。
 */
export const RECENT_CALLS_SHOWN = 6;
export const MAX_PLAN_CHARS = 600;

export function rotateCubeTool(limits: RunLimits, n = 3): ToolSpec {
  return {
    name: 'rotate_cube',
    description:
      `Rotate the outer faces of the ${n}x${n}x${n} cube. Executes the given moves in order and returns the new cube state. ` +
      `Allowed moves: R L U D F B (90° clockwise looking at that face), with ' for counter-clockwise and 2 for 180°. ` +
      `At most ${limits.maxMovesPerCall} moves may be supplied in one call. ` +
      `Put your sub-goal and remaining planned moves in "plan" so they remain available on the next turn. ` +
      `If any move is invalid, the whole call is rejected and nothing is executed.`,
    parameters: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          description: `Moves to execute in order, e.g. ["R", "U'", "F2"]. Prefer one coherent formula when it is known.`,
          minItems: 1,
          maxItems: limits.maxMovesPerCall,
          items: { type: 'string', enum: ALL_MOVES },
        },
        plan: {
          type: 'string',
          description:
            `Recommended. Your current sub-goal and the moves you intend to make after this call (e.g. the rest of a solution you worked out). ` +
            `Shown back to you on the next turn so you do not have to re-derive it. At most ${MAX_PLAN_CHARS} characters.`,
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
- 已确定的完整公式应尽量一次提交（最多 ${limits.maxMovesPerCall} 步）；只有下一步依赖新状态时才拆分，避免每次只转一步而增加请求往返。不要盲目提交很长的未知序列。
- 历史对话不会完整回放；上一轮工具交互会按协议保留，当前状态、最近几次调用的事实和你在 rotate_cube 的 plan 参数会一并提供。把未执行的后续动作写进 plan，下一轮不必重新推导。
- 不要用长篇文字代替工具调用；确定动作后直接调用 rotate_cube。
- 只要包含一个非法记号，整次调用会被拒绝且不执行任何转动。
- 单次调用最多 ${limits.maxMovesPerCall} 步；评测最多运行 ${limits.maxApiCalls} 次 API 调用、${limits.maxDurationSec} 秒，达到任一上限会结束本局。
- 连续 3 次没有调用工具会判定本局失败。
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

/** 一次模型调用实际执行的动作，用于后续几轮的提示（只陈述事实，不评价好坏） */
export interface CallRecap {
  n: number;
  /** 实际执行的动作；被拒绝或未调用工具时为空 */
  moves: string[];
  /** 被拒绝的原因，或「未调用工具」 */
  error?: string;
}

export interface TurnMemory {
  recent: CallRecap[];
  /** 模型最近一次写在 plan 参数里的计划，以及写下它的调用序号 */
  plan: { n: number; text: string } | null;
  /** 附加提醒（未调用工具、输出被截断等） */
  notes?: string[];
}

function recapLine(c: CallRecap): string {
  if (!c.moves.length) return `#${c.n} 未执行：${c.error ?? '未知原因'}`;
  return `#${c.n} ${c.moves.join(' ')}${c.error ? `（另有调用被拒绝：${c.error}）` : ''}`;
}

export function turnMessage(state: CubeState, memory: TurnMemory): string {
  const s = describeState(state);
  const first = !memory.recent.length;
  const lines = [
    first
      ? '这是本局魔方的初始状态，请开始调用 rotate_cube 复原。'
      : '这是魔方的当前状态。历史对话不会完整回放；下面附上上一轮的必要交互、最近几次调用执行的动作和你自己记下的计划。',
    '',
    '展开图：',
    s.net,
    '',
    '逐面格子：',
    s.faces,
  ];
  if (!first) lines.push('', '最近的调用（从旧到新）：', ...memory.recent.map(recapLine));
  lines.push(
    '',
    memory.plan
      ? `你在第 ${memory.plan.n} 次调用时记下的计划：${memory.plan.text}`
      : '你还没有记下计划。想好多步解法后，可以在 rotate_cube 的 plan 参数里写下当前小目标和后续动作，下一轮会原样提供给你。',
  );
  if (memory.notes?.length) lines.push('', ...memory.notes);
  if (!first) lines.push('', '请根据当前状态继续调用 rotate_cube。');
  return lines.join('\n');
}

export const NO_TOOL_NUDGE = '请通过调用 rotate_cube 工具继续转动魔方，不要只回复文字。';

export const TRUNCATED_NOTE = '注意：上一轮输出达到最大输出 Token 上限被截断。请缩短思考和文字说明，尽早调用 rotate_cube。';
