import type { ProviderConfig, ReasoningEffort } from '../../shared/types.ts';

/** 协议无关的工具定义（JSON Schema 仅使用各家都支持的子集） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 解析后的参数；解析失败时为 null，并在 argsError 说明 */
  args: Record<string, unknown> | null;
  argsError?: string;
}

/** 中立的对话记录；assistant 的 raw 为该协议原始消息，用于原样回放（推理内容、签名等） */
export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; raw: unknown }
  | { role: 'tool'; results: { callId: string; name: string; content: string }[] };

export interface Usage {
  input: number | null;
  /** 计费口径的全部输出 Token（含推理 Token） */
  output: number | null;
  /** 推理 Token（输出的组成部分），未提供为 null */
  reasoning: number | null;
  /** 供应商在响应中返回的计费金额（如 usage.cost），未提供为 null */
  cost: number | null;
}

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
  raw: unknown;
  finishReason: string | null;
}

export interface CallContext {
  config: ProviderConfig;
  model: string;
  /** default 表示不发送推理强度参数 */
  reasoningEffort: ReasoningEffort;
  endpoint: string;
  apiKey: string | undefined;
  system: string;
  tools: ToolSpec[];
  turns: Turn[];
  toolChoice: 'auto' | 'required';
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ProtocolAdapter {
  call(ctx: CallContext): Promise<TurnResult>;
}

export function parseArgs(raw: unknown): { args: Record<string, unknown> | null; argsError?: string } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { args: raw as Record<string, unknown> };
  if (typeof raw !== 'string' || !raw.trim()) return { args: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v };
    return { args: null, argsError: '工具参数不是 JSON 对象' };
  } catch {
    return { args: null, argsError: '工具参数不是合法 JSON' };
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export { num as usageNum };

/** Anthropic / Gemini 以思考 Token 预算表达推理强度 */
export const THINKING_BUDGET: Record<Exclude<ReasoningEffort, 'default'>, number> = { low: 2048, medium: 8192, high: 24576 };

/** 供应商返回的计费金额：OpenRouter 等在 usage.cost 中给出，字符串数字也接受 */
export function reportedCost(usage: any): number | null {
  const v = usage?.cost ?? usage?.total_cost;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}
