/** 前后端共用的数据结构；仅 BrowserProvider / ProviderDraft 包含临时使用的 API Key。 */

// ---------------- 模型配置 ----------------

export type ProtocolId = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';

export interface ProtocolInfo {
  id: ProtocolId;
  name: string;
  description: string;
  /** Base URL 示例（仅作占位提示） */
  baseUrlExample: string;
  defaultAuth: AuthMode;
}

export type AuthMode = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

export const PROTOCOLS: ProtocolInfo[] = [
  {
    id: 'openai-chat',
    name: 'OpenAI 兼容 · Chat Completions',
    description: '最通用的协议，DeepSeek、通义千问、Kimi、智谱、豆包、MiniMax 及绝大多数中转站均支持。',
    baseUrlExample: 'https://api.example.com/v1',
    defaultAuth: 'bearer',
  },
  {
    id: 'openai-responses',
    name: 'OpenAI · Responses API',
    description: 'OpenAI 新版 /responses 接口，工具调用格式与 Chat Completions 不同。',
    baseUrlExample: 'https://api.openai.com/v1',
    defaultAuth: 'bearer',
  },
  {
    id: 'anthropic',
    name: 'Anthropic · Messages API',
    description: 'Claude 原生 /v1/messages 接口（tool_use / tool_result）。',
    baseUrlExample: 'https://api.anthropic.com',
    defaultAuth: 'x-api-key',
  },
  {
    id: 'gemini',
    name: 'Google Gemini · generateContent',
    description: 'Gemini 原生接口（functionCall / functionResponse）。',
    baseUrlExample: 'https://generativelanguage.googleapis.com/v1beta',
    defaultAuth: 'x-goog-api-key',
  },
];

/** API Key 的来源：仅存在当前浏览器会话，不会写入服务端。 */
export type KeySource = 'none' | 'browser';

/** 供应商：只需协议 + Base URL + API Key，模型列表由供应商接口自动获取 */
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: ProtocolId;
  baseUrl: string;
  authMode: AuthMode;
  /** 同一密钥 + 同一主机的最大并发请求数（中转站常有每用户并发限制），null = 不限 */
  maxConcurrentRequests: number | null;
  /** 从供应商获取到的模型 */
  models: string[];
  /** 供应商不支持模型列表时，用户手动补充的模型 */
  manualModels: string[];
  modelsFetchedAt: string | null;
  /** 获取模型列表失败的原因（已脱敏） */
  modelsError: string | null;
  keySource: KeySource;
  createdAt: string;
  updatedAt: string;
}

/** 前端供应商草稿；API Key 只在当前浏览器会话中保存。 */
export interface ProviderDraft {
  /** 可留空，默认使用主机名 */
  name?: string;
  protocol: ProtocolId;
  baseUrl: string;
  authMode?: AuthMode;
  maxConcurrentRequests?: number | null;
  manualModels?: string[];
  /** 为空字符串/undefined 表示保持原有密钥 */
  apiKey?: string;
}

/** 浏览器会话中的完整供应商记录，apiKey 不会出现在服务端响应或评测记录中。 */
export interface BrowserProvider extends ProviderConfig {
  apiKey: string;
}

/** 推理强度：default 表示不发送该参数，由供应商决定 */
export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: { id: ReasoningEffort; name: string }[] = [
  { id: 'default', name: '默认' },
  { id: 'low', name: '低' },
  { id: 'medium', name: '中' },
  { id: 'high', name: '高' },
];

/** 一名参赛者：某个供应商的某个模型 + 推理强度 */
export interface RunEntry {
  providerId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  /** 单次回复的最大输出 Token；null 表示交给供应商默认 */
  maxOutputTokens?: number | null;
}

export type ToolSupport = 'supported' | 'not_called' | 'rejected' | 'unknown';

export interface ConnectionTestResult {
  ok: boolean;
  endpoint: string;
  latencyMs: number | null;
  httpStatus: number | null;
  /** 中文说明，已脱敏 */
  message: string;
  detail?: string;
  toolSupport: ToolSupport;
  toolMessage: string;
  usageReported: boolean;
  hints: string[];
}

// ---------------- 评测 ----------------

export interface Difficulty {
  id: string;
  name: string;
  scrambleLength: number;
}

/** 打乱强度预设（也可自由填写 1～100 步） */
export const DIFFICULTIES: Difficulty[] = [
  { id: 'easy', name: '简单', scrambleLength: 10 },
  { id: 'standard', name: '标准', scrambleLength: 20 },
  { id: 'hard', name: '困难', scrambleLength: 40 },
  { id: 'extreme', name: '极限', scrambleLength: 60 },
];

export const MAX_SCRAMBLE_LENGTH = 100;

/** 旧版本记录只保存了难度 id，按当时的定义换算打乱步数 */
const LEGACY_SCRAMBLE: Record<string, number> = { easy: 3, normal: 6, hard: 10, full: 20 };

export function scrambleLengthOf(r: { scrambleLength?: number; difficulty: string; scramble?: string }): number {
  return r.scrambleLength ?? LEGACY_SCRAMBLE[r.difficulty] ?? r.scramble?.split(' ').filter(Boolean).length ?? 0;
}

/** 打乱步数对应的强度名称 */
export function scrambleLevelName(n: number): string {
  const exact = DIFFICULTIES.find((d) => d.scrambleLength === n);
  if (exact) return exact.name;
  return n < 10 ? '入门' : n < 20 ? '简单' : n < 40 ? '标准' : n < 60 ? '困难' : '极限';
}

/** 支持的魔方阶数（只允许外层转动） */
export const CUBE_SIZE_INFO: { n: number; name: string; level: string }[] = [
  { n: 2, name: '2×2', level: '入门' },
  { n: 3, name: '3×3', level: '经典' },
  { n: 4, name: '4×4', level: '进阶' },
  { n: 5, name: '5×5', level: '专业' },
];

/** 不限制总旋转次数；每局由最大 API 调用次数与最大运行时间约束 */
export interface RunLimits {
  maxDurationSec: number;
  maxApiCalls: number;
  /** 单次 rotate_cube 调用最多包含的转动数 */
  maxMovesPerCall: number;
  /** 连续没有产生工具调用时允许的最大轮数 */
  maxNoToolCalls: number;
  /** 连续调用后 canonical state 未变化时允许的最大轮数 */
  maxNoProgressCalls: number;
  /** 保留给供应商的最近完整协议回合数；更早回合由 canonical state 摘要替代 */
  maxHistoryRounds: number;
  /** 发送给供应商的近似上下文字符预算 */
  maxContextChars: number;
  /** 同时运行的模型数 */
  concurrency: number;
  /** 单次 API 请求超时（秒） */
  requestTimeoutSec: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxDurationSec: 600,
  maxApiCalls: 60,
  maxMovesPerCall: 10,
  maxNoToolCalls: 3,
  maxNoProgressCalls: 3,
  maxHistoryRounds: 3,
  maxContextChars: 120_000,
  concurrency: 4,
  requestTimeoutSec: 120,
};

export type ContestantStatus = 'queued' | 'running' | 'paused' | 'solved' | 'failed' | 'stopped' | 'error';

export const TERMINAL_STATUSES: ContestantStatus[] = ['solved', 'failed', 'stopped', 'error'];

/** 参赛快照：评测时冻结的标识（无密钥） */
export interface ContestantInfo {
  id: string;
  /** 供应商 ID（沿用旧字段名，兼容历史记录） */
  configId: string;
  /** 供应商名称 */
  name: string;
  protocol: ProtocolId;
  /** 供应商主机名，例如 api.deepseek.com */
  host: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number | null;
}

export interface ContestantStats {
  moves: number;
  qtm: number;
  /** 计入预算的 API 调用（不含被限流拒绝的请求） */
  apiCalls: number;
  /** 被供应商限流（HTTP 429）拒绝的请求数，不计入 API 调用预算 */
  throttledCalls: number;
  toolCalls: number;
  invalidToolCalls: number;
  /** null = 供应商未返回 */
  inputTokens: number | null;
  outputTokens: number | null;
  /** 推理 Token：属于输出 Token 的组成部分，仅展示，不重复累加 */
  reasoningTokens: number | null;
  /** 未返回用量的 API 调用次数 */
  usageMissingCalls: number;
  apiLatencyMs: number;
  lastLatencyMs: number | null;
  durationMs: number;
  /** 供应商返回的计费金额（usage.cost）之和；null = 供应商未返回 */
  cost: number | null;
  /** 推理强度参数被模型拒绝后已按默认继续 */
  effortIgnored?: boolean;
  correctStickers: number;
  lastMove: string | null;
}

export interface ContestantState {
  info: ContestantInfo;
  status: ContestantStatus;
  failReason: string | null;
  stats: ContestantStats;
}

export type TraceItem =
  | { t: number; type: 'move'; move: string; index: number }
  | {
      t: number;
      type: 'call';
      n: number;
      latencyMs: number;
      text: string;
      /** 模型返回的思考内容（过长时保留首尾）；未返回则省略 */
      reasoning?: string;
      /** 输出达到最大输出 Token 被截断 */
      truncated?: boolean;
      /** 模型在 rotate_cube 的 plan 参数里记下的计划（下一轮会提供给模型） */
      plan?: string;
      tools: { moves: string[]; ok: boolean; error?: string }[];
      /** 本次调用供应商返回的用量（未返回为 null） */
      usage?: { input: number | null; output: number | null; reasoning: number | null };
      /** 请求完成状态；error 表示请求失败但已记录耗时 */
      outcome?: 'success' | 'error';
      error?: string;
    }
  | { t: number; type: 'status'; status: ContestantStatus; reason?: string }
  | { t: number; type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export interface RunSummary {
  id: string;
  /** 服务端私有归属标识；不出现在 PublicRunSummary。 */
  ownerId?: string;
  createdAt: string;
  difficulty: string;
  /** 魔方阶数；旧记录没有该字段，视为 3 */
  cubeSize?: number;
  /** 打乱步数；旧记录用 scrambleLengthOf 换算 */
  scrambleLength?: number;
  finishedAt?: string;
  /** 报告因容量限制未完整持久化。 */
  reportIncomplete?: boolean;
  scramble: string;
  /** 6×N×N 个字符，URFDLB 顺序 */
  initialState: string;
  limits: RunLimits;
  status: 'running' | 'finished';
  contestants: ContestantState[];
}

export interface RunRecord extends RunSummary {
  traces: Record<string, TraceItem[]>;
}

/** 运行中的公开摘要：不包含可直接泄露题目的 scramble 和初始面状态。 */
export type PublicRunSummary = Omit<RunSummary, 'scramble' | 'initialState' | 'ownerId'>;

export type CallTrace = Extract<TraceItem, { type: 'call' }>;
export type PublicCallTrace = Omit<CallTrace, 'reasoning'>;
export type PublicTraceItem = Exclude<TraceItem, CallTrace> | PublicCallTrace;

export interface PublicRunRecord extends PublicRunSummary {
  traces: Record<string, PublicTraceItem[]>;
}

export type RunEvent =
  | { type: 'init'; run: PublicRunSummary }
  | { type: 'reset'; run: PublicRunSummary; minSeq: number; latestSeq: number }
  | { type: 'status'; cid: string; status: ContestantStatus; reason: string | null; t: number }
  | { type: 'move'; cid: string; move: string; index: number; t: number }
  | { type: 'call'; cid: string; item: Extract<TraceItem, { type: 'call' }> }
  | { type: 'stats'; cid: string; stats: ContestantStats }
  | { type: 'log'; cid: string; level: 'info' | 'warn' | 'error'; text: string; t: number }
  | { type: 'done'; run: PublicRunSummary };

export interface RunEventEnvelope {
  seq: number;
  event: RunEvent;
}
