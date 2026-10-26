import { randomUUID } from 'node:crypto';
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
  /** 供应商返回的思考内容（reasoning_content、thinking 块、推理摘要等），未返回为空字符串 */
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
  raw: unknown;
  finishReason: string | null;
  /** 输出达到最大输出 Token 被截断，工具调用可能缺失或参数不完整 */
  truncated: boolean;
  /** 该协议是否支持 required/ANY 工具选择；未提供时视为支持。 */
  forcedToolSupported?: boolean;
}

export class DeadlineExceededError extends Error {
  constructor() { super('运行时间已到期'); }
}

export interface CallContext {
  config: ProviderConfig;
  model: string;
  /** default 表示不发送推理强度参数 */
  reasoningEffort: ReasoningEffort;
  /** 单次回复最大输出 Token；不设置则交给供应商默认 */
  maxOutputTokens?: number | null;
  endpoint: string;
  apiKey: string | undefined;
  system: string;
  tools: ToolSpec[];
  turns: Turn[];
  toolChoice: 'auto' | 'required';
  signal: AbortSignal;
  /** null 表示不限制单次请求时长，由整局限制或手动停止控制 */
  timeoutMs: number | null;
  /** 本次运行的绝对截止时间；adapter 内部 fallback 共享同一 deadline。 */
  deadlineMs?: number;
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

export function normalizeToolCallId(raw: unknown, prefix: string): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : `${prefix}_${randomUUID()}`;
}

export function normalizeToolName(raw: unknown, allowed?: ReadonlySet<string>): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const name = raw.trim();
  return allowed && !allowed.has(name) ? null : name;
}

/** 将 provider 可能返回的 object arguments 规范化为协议回放所需的 JSON 字符串。 */
export function normalizeArguments(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? raw : '{}';
    } catch { return '{}'; }
  }
  try { return JSON.stringify(raw ?? {}); } catch { return '{}'; }
}

export function argumentsError(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? undefined : '工具参数不是 JSON 对象';
  } catch { return '工具参数不是合法 JSON'; }
}

export function contextTimeout(ctx: Pick<CallContext, 'timeoutMs' | 'deadlineMs'>): number | null {
  const remaining = ctx.deadlineMs == null ? null : ctx.deadlineMs - Date.now();
  if (remaining !== null && remaining <= 0) throw new DeadlineExceededError();
  if (remaining === null) return ctx.timeoutMs;
  return ctx.timeoutMs == null ? remaining : Math.min(ctx.timeoutMs, remaining);
}

/** 部分模型（如经中转的 R1 类模型）把思考写在正文的 <think>…</think> 中：拆出思考，正文只保留回答；未闭合视为被截断的思考 */
export function splitThinkTags(content: string): { text: string; reasoning: string } {
  const thoughts: string[] = [];
  const text = content.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_, t: string) => {
    thoughts.push(t.trim());
    return '';
  });
  return thoughts.length ? { text: text.trim(), reasoning: thoughts.filter(Boolean).join('\n\n') } : { text: content, reasoning: '' };
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
