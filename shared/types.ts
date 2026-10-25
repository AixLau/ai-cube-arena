/** 前后端共用的数据结构（不包含任何 API Key） */

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

export type KeySource = 'none' | 'memory' | 'encrypted' | 'env';

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
  /** 服务端环境变量预置的供应商只读 */
  readonly?: boolean;
  keySource: KeySource;
  createdAt: string;
  updatedAt: string;
}

/** 前端提交的供应商草稿：apiKey 仅在新建/修改时随请求发送，服务端永不回传 */
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
  /** 明确选择后才加密持久化 */
  persistKey?: boolean;
  /** 明确清除已保存的密钥 */
  clearKey?: boolean;
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

/** 打乱程度（与魔方阶数组合成最终难度） */
export const DIFFICULTIES: Difficulty[] = [
  { id: 'easy', name: '简单 · 3 步打乱', scrambleLength: 3 },
  { id: 'normal', name: '普通 · 6 步打乱', scrambleLength: 6 },
  { id: 'hard', name: '困难 · 10 步打乱', scrambleLength: 10 },
  { id: 'full', name: '完全打乱 · 20 步', scrambleLength: 20 },
];

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
  /** 同时运行的模型数 */
  concurrency: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxDurationSec: 600,
  maxApiCalls: 60,
  maxMovesPerCall: 10,
  concurrency: 4,
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
  | { t: number; type: 'call'; n: number; latencyMs: number; text: string; tools: { moves: string[]; ok: boolean; error?: string }[] }
  | { t: number; type: 'status'; status: ContestantStatus; reason?: string }
  | { t: number; type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export interface RunSummary {
  id: string;
  createdAt: string;
  difficulty: string;
  /** 魔方阶数；旧记录没有该字段，视为 3 */
  cubeSize?: number;
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

export type RunEvent =
  | { type: 'init'; run: RunSummary }
  | { type: 'status'; cid: string; status: ContestantStatus; reason: string | null; t: number }
  | { type: 'move'; cid: string; move: string; index: number; t: number }
  | { type: 'call'; cid: string; item: Extract<TraceItem, { type: 'call' }> }
  | { type: 'stats'; cid: string; stats: ContestantStats }
  | { type: 'log'; cid: string; level: 'info' | 'warn' | 'error'; text: string; t: number }
  | { type: 'done'; run: RunSummary };
