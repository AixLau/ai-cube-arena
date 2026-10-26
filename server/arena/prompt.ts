import { createHash } from 'node:crypto';
import { ALL_MOVES, correctStickers, stateToFaceList, stateToNet, type CubeState } from '../../shared/cube.ts';
import type { RunLimits } from '../../shared/types.ts';
import type { ToolSpec } from '../adapters/types.ts';

/** 魔方状态编码规范版本：所有参赛模型使用同一规范 */
export const STATE_ENCODING = 'facelet-net-v1';

/** 最近事实摘要只用于帮助模型定位；canonical state 和原始协议历史由编排器维护。 */
export const RECENT_CALLS_SHOWN = 6;
export const MAX_PLAN_CHARS = 600;

export function stateHash(state: CubeState): string {
  return createHash('sha256').update(state.join('')).digest('hex').slice(0, 16);
}

export function rotateCubeTool(limits: RunLimits, n = 3): ToolSpec {
  return {
    name: 'rotate_cube',
    description:
      `目的：执行一组按顺序排列的合法外层旋转，并返回执行后的完整 canonical state。当前魔方为 ${n}x${n}x${n}。\n` +
      `调用时机：只有在读取最近一次完整状态并确定下一小段动作后调用。moves 必须包含 1 到 ${limits.maxMovesPerCall} 个动作。\n` +
      `约束：动作只能来自当前 schema 的 18 个记号。输入按整批校验；任一动作非法或参数无效时，整批拒绝且不执行任何动作，不得原样重试。\n` +
      `输出：ok、solved、state（编码、尺寸、展开图、逐面格子、state_hash、动作计数）、applied_moves 和 error。\n` +
      `错误：error.code 标识失败类别，error.message 说明修正方向，error.retryable 只表示修正输入后是否可以再次规划。最新工具结果优先于旧计划。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
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
          maxLength: MAX_PLAN_CHARS,
          description: '可选：当前子目标和下一小段动作的简短备注；它不是事实来源，也不能替代最新状态。',
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
  if (n === 4) return '当前只允许外层转动；中心块不会跨到其他面，但会随外层转动在本面内旋转，可用于判断目标颜色。';
  return '当前只允许外层转动；中心块不会跨到其他面，但会随外层转动在本面内旋转，可用于判断目标颜色。';
}

export function systemPrompt(limits: RunLimits, n: number = 3): string {
  const name = ORDER_NAME[n] ?? `${n} 阶`;
  const rows = Array.from({ length: n }, (_, i) => `第${i + 1}行`).join('/');
  return `你是一个严格、可靠、以工具调用为核心的 AI 魔方求解 Agent。

<role>
你的职责是读取当前 canonical state，规划可验证的小段旋转，并通过 rotate_cube 改变魔方。实际旋转、成功判定和失败判定都由工具结果与编排器决定。
</role>

<objective>
通过唯一的 rotate_cube 工具，将当前 ${n}×${n}×${n} 的${name}魔方完整复原。只有工具返回 solved=true 才算成功；收到 solved=true 后立即停止调用。
不要只输出未执行的动作，不要根据过期状态声称已复原。
</objective>

<runtime_limits>
魔方尺寸：${n}×${n}×${n}
单次最大动作数：${limits.maxMovesPerCall}
最大 API 调用次数：${limits.maxApiCalls}
最大运行时间：${limits.maxDurationSec} 秒
连续无工具阈值：${limits.maxNoToolCalls}
连续无进展阈值：${limits.maxNoProgressCalls}
历史保留回合数：${limits.maxHistoryRounds}
近似上下文字符预算：${limits.maxContextChars}
</runtime_limits>

<state_contract>
1. 最近一次完整工具结果中的 state 是唯一可信事实；其中 state_hash 用于判断状态是否变化。
2. 不依赖过期内部记忆、旧计划或未经工具确认的推断。
3. 每次工具调用后都根据最新完整状态重新识别阶段和下一步。
4. 工具返回 ok=true 只表示调用被接受，不表示任务已成功；只有 solved=true 才能停止。
5. 工具错误时，以错误结果中返回的最新 state 为准。
</state_contract>

<tool_policy>
1. 所有实际旋转必须通过 rotate_cube 完成。
2. moves 数量必须在 1 到 ${limits.maxMovesPerCall} 之间，且每个动作符合 schema。
3. 整批拒绝视为零动作执行；修正输入或缩短批次后重新规划，不得原样重试。
4. 每次 assistant 响应只提交一个 rotate_cube 调用；不要并行提交多个依赖状态的调用。
5. 不在普通文本中伪造已执行动作，不输出隐藏思维链或未经验证的长计划。
</tool_policy>

<planning_policy>
先识别当前阶段和未完成部分，再规划一小段合法动作；优先保持已完成结构。确定性高时可提交较长但不超过上限的公式，不确定或刚发生错误时缩短批次。当前工具只支持外层 R/L/U/D/F/B 及其变体，不支持内层、宽层或 M/E/S；4×4 和 5×5 不要规划无法由当前动作空间表达的 reduction 算法。
</planning_policy>

<loop>
读取完整状态 → 识别阶段 → 规划小段动作 → 调用 rotate_cube → 读取完整结果 → 检查 solved、state_hash、错误和预算 → solved=true 时停止，否则丢弃不再适用的旧计划并基于最新状态重新规划。
</loop>

<error_recovery>
参数格式错误：修正字段后重试。动作数量超限：缩短批次。非法动作：从合法集合重新选择。整批拒绝：视为零动作执行，不原样重试。状态与预期不一致：丢弃旧计划，使用最新 state。连续 state_hash 不变：停止重复策略并重新识别阶段；达到无进展阈值时停止。
</error_recovery>

<termination>
工具返回 solved=true、达到 API 调用或时间预算、连续无工具达到阈值、连续无进展达到阈值，或工具明确报告无法继续时，停止调用并报告最后一个工具状态。
</termination>

<response_policy>
动作必须放在工具调用中。普通文本只提供简短状态更新；除非工具返回 solved=true，否则不要声称魔方已复原。成功时确认已复原，失败时说明最后状态、错误原因和剩余预算。
</response_policy>

<encoding>
复原配色：U=上(白) D=下(黄) F=前(绿) B=后(蓝) R=右(红) L=左(橙)。${orientationNote(n)}
状态编码 ${STATE_ENCODING}：每个面按行优先（左上→右下）列出，格式“面: ${rows}”；F/R/B/L 正对该面观察，U 从上往下看，D 从下往上看；展开图为 U / L F R B / D。
只允许 R L U D F B 及其 '、2 后缀，不允许 x/y/z、M/E/S、宽层或内层转动。
</encoding>`;
}

export function describeState(state: CubeState): { encoding: string; size: number; net: string; faces: string; hash: string; correct: number; total: number } {
  const size = Math.sqrt(state.length / 6);
  return {
    encoding: STATE_ENCODING,
    size,
    net: stateToNet(state),
    faces: stateToFaceList(state),
    hash: stateHash(state),
    correct: correctStickers(state),
    total: state.length,
  };
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
  /** canonical state 中累计执行的动作数 */
  movesUsed?: number;
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
      ? '这是本局魔方的初始 canonical state，请开始调用 rotate_cube。'
      : '这是最新 canonical state；请忽略旧计划，以最近工具结果为准。',
    '',
    '状态摘要（机器事实）：',
    JSON.stringify({ encoding: s.encoding, size: s.size, state_hash: s.hash, solved: s.correct === s.total, moves_used: memory.movesUsed ?? null, correct_stickers: `${s.correct}/${s.total}` }),
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
      ? `模型在第 ${memory.plan.n} 次调用时记下的备注（仅供参考）：${memory.plan.text}`
      : '当前没有模型备注。备注不能替代工具返回的 state。',
  );
  if (memory.notes?.length) lines.push('', ...memory.notes);
  if (!first) lines.push('', '请根据这个最新状态继续调用 rotate_cube。');
  return lines.join('\n');
}

export const NO_TOOL_NUDGE = '请通过调用 rotate_cube 工具继续转动魔方，不要只回复文字。';

export const TRUNCATED_NOTE = '注意：上一轮输出达到最大输出 Token 上限被截断。请缩短思考和文字说明，尽早调用 rotate_cube。';
