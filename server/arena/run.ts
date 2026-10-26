import { createHash, randomUUID } from 'node:crypto';
import {
  applyMove, correctStickers, formatAlg, isSolved, parseMove, quarterTurns, randomScramble,
  solvedState, type CubeState, type Move,
} from '../../shared/cube.ts';
import { hostOf, resolveEndpoint } from '../../shared/endpoint.ts';
import {
  TERMINAL_STATUSES, type ContestantInfo, type ContestantState, type ContestantStats, type ContestantStatus,
  type Difficulty, type ProviderConfig, type ReasoningEffort, type RunEvent, type RunEventEnvelope, type RunLimits, type RunRecord, type RunSummary, type PublicRunRecord, type PublicRunSummary, type TraceItem,
} from '../../shared/types.ts';
import { ADAPTERS } from '../adapters/index.ts';
import { ProviderError } from '../adapters/http.ts';
import { DeadlineExceededError, type ToolCall, type Turn, type TurnResult } from '../adapters/types.ts';
import { redact } from '../security/redact.ts';
import {
  describeState, MAX_PLAN_CHARS, NO_TOOL_NUDGE, RECENT_CALLS_SHOWN, rotateCubeTool, systemPrompt, TRUNCATED_NOTE, turnMessage,
  type CallRecap, type TurnMemory,
} from './prompt.ts';
import { saveRun } from './store.ts';

/** 简单的计数信号量，用于单局并发与全局并发控制 */
export class Semaphore {
  private waiters: (() => void)[] = [];
  inUse = 0;
  waiterCount = 0;
  constructor(private free: number) {}
  async acquire(signal?: AbortSignal, deadlineMs?: number): Promise<boolean> {
    if (deadlineMs != null && Date.now() >= deadlineMs) return false;
    if (this.free > 0) {
      this.free--;
      this.inUse++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let queued = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (queued) { queued = false; this.waiterCount--; }
        if (value) this.inUse++;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        finish(false);
      };
      const onTimeout = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        finish(false);
      };
      const grant = () => {
        finish(true);
      };
      this.waiters.push(grant);
      this.waiterCount++;
      if (deadlineMs != null) timer = setTimeout(onTimeout, Math.max(0, deadlineMs - Date.now()));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  release() {
    if (this.inUse > 0) this.inUse--;
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new StopSignal());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new StopSignal());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 全局同时进行的模型会话上限，防止供应商限流与服务端过载 */
export function positiveIntEnv(value: string | undefined, fallback: number, max = 256): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export const MAX_ACTIVE_SESSIONS = positiveIntEnv(process.env.MAX_ACTIVE_SESSIONS, 16);
export const globalSessions = new Semaphore(MAX_ACTIVE_SESSIONS);

/** 同一密钥 + 同一主机共享的请求并发上限（键为哈希，内存中也不保存密钥原文） */
const credentialLimiters = new Map<string, { semaphore: Semaphore; lastUsedAt: number }>();
function credentialLimiter(host: string, apiKey: string | undefined, limit: number | null): Semaphore | null {
  if (!limit) return null;
  const key = createHash('sha256').update(`${host}\0${apiKey ?? ''}\0${limit}`).digest('hex');
  const now = Date.now();
  let entry = credentialLimiters.get(key);
  if (!entry) credentialLimiters.set(key, (entry = { semaphore: new Semaphore(limit), lastUsedAt: now }));
  entry.lastUsedAt = now;
  return entry.semaphore;
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [key, entry] of credentialLimiters) {
    if (entry.lastUsedAt < cutoff && entry.semaphore.inUse === 0 && entry.semaphore.waiterCount === 0) credentialLimiters.delete(key);
  }
}, 10 * 60_000).unref();

/** 网络错误、超时、5xx 的重试次数（计入 API 调用预算） */
const MAX_RETRIES = 2;
/** 限流（429）的重试次数（不计入预算，但受最大运行时间约束） */
const MAX_THROTTLE_RETRIES = 8;
const EFFORT_PARAM_RE = /reasoning[_ .-]?effort|thinking[_ .-]?budget|budget[_ .-]?tokens|thinkingConfig/i;
const TOOL_CHOICE_PARAM_RE = /tool_choice|tool choice|function_?calling_?config|functionCallingConfig/i;
const GENERIC_REJECT_RE = /unrecognized|unknown (field|param)|unsupported|not support|extra (fields|inputs)/i;
/** 错误信息点名了这些字段时，泛化的「不支持」不归因到可选参数 */
const OTHER_PARAM_RE = /max_(completion_|output_)?tokens|maxOutputTokens|\btools?\b|functionDeclarations/i;

/**
 * 400 错误是否在拒绝某个可选参数：按错误信息点名的字段判断，
 * 避免把 max_tokens、tools 等其它字段的拒绝误判为推理强度不受支持。
 */
function rejectedOptionalParam(err: ProviderError, sent: { effort: boolean; forcedTool: boolean }): 'effort' | 'toolChoice' | null {
  if (err.status !== 400) return null;
  const m = err.message;
  const generic = GENERIC_REJECT_RE.test(m) && !OTHER_PARAM_RE.test(m);
  if (sent.forcedTool && (TOOL_CHOICE_PARAM_RE.test(m) || (generic && !EFFORT_PARAM_RE.test(m)))) return 'toolChoice';
  if (sent.effort && EFFORT_PARAM_RE.test(m) && (generic || /not (accepted|allowed|supported)|invalid parameter/i.test(m))) return 'effort';
  return null;
}

/** 思考内容可能很长：保留开头与结尾（结论通常在末尾），控制事件与记录体积 */
const MAX_TRACE_REASONING = 4000;
export const MAX_TRACE_ITEMS = 20_000;
export const MAX_RUN_EVENTS = 50_000;
function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 4);
  return `${s.slice(0, head)}\n…（省略 ${s.length - max} 字）…\n${s.slice(s.length - (max - head))}`;
}

export interface ContestantEntry {
  config: ProviderConfig;
  apiKey?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number | null;
}

const emptyStats = (state: CubeState): ContestantStats => ({
  moves: 0, qtm: 0, apiCalls: 0, throttledCalls: 0, toolCalls: 0, invalidToolCalls: 0,
  inputTokens: null, outputTokens: null, reasoningTokens: null, usageMissingCalls: 0,
  apiLatencyMs: 0, lastLatencyMs: null, durationMs: 0, cost: null,
  correctStickers: correctStickers(state), lastMove: null,
});

class StopSignal extends Error {}

/**
 * 保留最近完整协议回合，避免 assistant/tool 关联被截断；更早状态由最新
 * canonical state 和 recent recap 取代。每个回合形态为：state → assistant
 * → (tool) → state，拼接时后续回合复用前一回合的 state 边界。
 */
function clipReplayText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 40))}\n…（上下文预算截断）…`;
}

function shrinkTurn(turn: Turn): Turn {
  // canonical state 和结构化 tool result 不能被字符串截断；超出预算时让
  // 调用层确定性失败，而不是把协议 JSON 或状态面数据剪坏。
  if (turn.role !== 'assistant') return turn;
  return { ...turn, text: clipReplayText(turn.text, 2000), raw: turn.raw };
}

function compactTurns(turns: Turn[], maxRounds: number, maxChars: number): { turns: Turn[]; droppedRounds: number; overflow: boolean } {
  const assistants = turns.map((t, i) => (t.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  if (!assistants.length) {
    const only = turns.slice(-1).map(shrinkTurn);
    return { turns: only, droppedRounds: 0, overflow: JSON.stringify(only).length > maxChars };
  }
  const rounds: Turn[][] = assistants.map((index, i) => {
    const start = i === 0 ? 0 : Math.max(0, index - 1);
    const end = i + 1 < assistants.length ? assistants[i + 1] - 1 : turns.length - 1;
    return turns.slice(start, end + 1);
  });
  const build = (count: number) => rounds.slice(-count).flatMap((round, i) => (i === 0 ? round : round.slice(1)));
  let count = Math.max(1, Math.min(Math.floor(maxRounds), rounds.length));
  let candidate = build(count);
  while (count > 1 && JSON.stringify(candidate).length > maxChars) {
    count--;
    candidate = build(count);
  }
  if (JSON.stringify(candidate).length > maxChars) candidate = candidate.map(shrinkTurn);
  return { turns: candidate, droppedRounds: rounds.length - count, overflow: JSON.stringify(candidate).length > maxChars };
}

function sanitizeReplayRaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeReplayRaw);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'plan' && typeof child === 'string') out[key] = child.trim().slice(0, MAX_PLAN_CHARS);
    else if (key === 'arguments' && typeof child === 'string') {
      try { out[key] = JSON.stringify(sanitizeReplayRaw(JSON.parse(child))); }
      catch { out[key] = child; }
    } else out[key] = sanitizeReplayRaw(child);
  }
  return out;
}

export class Contestant {
  readonly info: ContestantInfo;
  status: ContestantStatus = 'queued';
  failReason: string | null = null;
  stats: ContestantStats;
  readonly trace: TraceItem[] = [];
  /** 每位选手独立的魔方状态（不可变数组，转动产生新数组） */
  private state: CubeState;
  private abort = new AbortController();
  private paused = false;
  private pausedFromQueued = false;
  private resumeWaiters: (() => void)[] = [];
  private activeSince: number | null = null;

  private appendTrace(item: TraceItem) {
    if (this.trace.length >= MAX_TRACE_ITEMS) this.trace.shift();
    this.trace.push(item);
  }

  private config: ProviderConfig | undefined;
  private readonly model: string;
  private readonly maxOutputTokens: number | null;
  private apiKey: string | undefined;
  /** 推理强度；被模型拒绝后降级为 default 继续 */
  private effort: ReasoningEffort;

  constructor(
    private readonly run: Run,
    entry: ContestantEntry,
  ) {
    this.config = entry.config;
    this.model = entry.model;
    this.effort = entry.reasoningEffort;
    this.maxOutputTokens = entry.maxOutputTokens ?? null;
    this.apiKey = entry.apiKey;
    this.state = run.initialState;
    this.stats = emptyStats(this.state);
    const endpoint = resolveEndpoint(this.config.protocol, this.config.baseUrl, this.model);
    this.info = {
      id: randomUUID(),
      configId: this.config.id,
      name: this.config.name,
      protocol: this.config.protocol,
      host: hostOf(endpoint),
      model: this.model,
      reasoningEffort: entry.reasoningEffort,
      maxOutputTokens: this.maxOutputTokens,
    };
  }

  snapshot(): ContestantState {
    return { info: this.info, status: this.status, failReason: this.failReason, stats: { ...this.stats, durationMs: this.elapsed() } };
  }

  private now() {
    return Date.now() - this.run.startedAt;
  }

  private elapsed() {
    return this.stats.durationMs + (this.activeSince ? Date.now() - this.activeSince : 0);
  }

  private clockStart() {
    if (!this.activeSince) this.activeSince = Date.now();
  }

  private clockStop() {
    if (this.activeSince) {
      this.stats.durationMs += Date.now() - this.activeSince;
      this.activeSince = null;
    }
  }

  /** 计时只在真正等待暂停时停止：点击暂停时进行中的请求仍计入整局耗时 */
  private setStatus(status: ContestantStatus, reason: string | null = null) {
    if (TERMINAL_STATUSES.includes(status)) this.clockStop();
    else if (status === 'running' && this.stats.apiCalls === 0) this.clockStart();
    this.status = status;
    if (reason) this.failReason = reason;
    const t = this.now();
    this.appendTrace({ t, type: 'status', status, reason: reason ?? undefined });
    this.run.emit({ type: 'status', cid: this.info.id, status, reason, t });
    this.emitStats();
  }

  private emitStats() {
    this.run.emit({ type: 'stats', cid: this.info.id, stats: { ...this.stats, durationMs: this.elapsed() } });
  }

  private log(level: 'info' | 'warn' | 'error', text: string) {
    const t = this.now();
    this.appendTrace({ t, type: 'log', level, text });
    this.run.emit({ type: 'log', cid: this.info.id, level, text, t });
  }

  pause() {
    if (this.status !== 'running' && this.status !== 'queued') return false;
    this.pausedFromQueued = this.status === 'queued';
    this.paused = true;
    this.setStatus('paused');
    return true;
  }

  resume() {
    if (this.status !== 'paused') return false;
    this.paused = false;
    if (this.pausedFromQueued) {
      this.pausedFromQueued = false;
      this.setStatus('queued');
    } else this.setStatus('running');
    this.resumeWaiters.splice(0).forEach((fn) => fn());
    return true;
  }

  stop(reason = '已手动停止') {
    if (TERMINAL_STATUSES.includes(this.status)) return false;
    this.failReason = reason;
    this.abort.abort();
    this.resumeWaiters.splice(0).forEach((fn) => fn());
    return true;
  }

  private async checkpoint() {
    if (this.paused && !this.abort.signal.aborted) {
      this.clockStop();
      while (this.paused && !this.abort.signal.aborted) {
        await new Promise<void>((r) => this.resumeWaiters.push(r));
      }
      this.clockStart();
      this.emitStats();
    }
    if (this.abort.signal.aborted) throw new StopSignal();
  }

  private async acquireSlot(slot: Semaphore): Promise<boolean> {
    for (;;) {
      const ok = await slot.acquire(this.abort.signal, this.run.startedAt + this.run.limits.maxDurationSec * 1000);
      if (!ok) return false;
      if (!this.paused) return true;
      slot.release();
      await this.checkpoint();
    }
  }

  private async acquireCredential(slot: Semaphore): Promise<boolean> {
    for (;;) {
      this.clockStop();
      const ok = await slot.acquire(this.abort.signal, this.run.startedAt + this.run.limits.maxDurationSec * 1000);
      this.clockStart();
      if (!ok) return false;
      if (this.paused) {
        slot.release();
        await this.checkpoint();
        continue;
      }
      try {
        await this.checkpoint();
        return true;
      } catch (error) {
        slot.release();
        throw error;
      }
    }
  }

  private queueExpired() {
    return Date.now() - this.run.startedAt >= this.run.limits.maxDurationSec * 1000;
  }

  private addUsage(u: { input: number | null; output: number | null; reasoning: number | null; cost: number | null } | null) {
    const s = this.stats;
    if (!u || u.input === null || u.output === null) s.usageMissingCalls++;
    if (u?.input != null) s.inputTokens = (s.inputTokens ?? 0) + u.input;
    if (u?.output != null) s.outputTokens = (s.outputTokens ?? 0) + u.output;
    // 推理 Token 是输出 Token 的一部分，只单独累计展示，不加到输出里
    if (u?.reasoning != null) s.reasoningTokens = (s.reasoningTokens ?? 0) + u.reasoning;
    // 费用只采用供应商在响应中返回的计费金额，不按任何价格表估算
    if (u?.cost != null) s.cost = (s.cost ?? 0) + u.cost;
  }

  /** 执行一次 rotate_cube 调用，返回给模型的完整结构化工具结果 */
  private async executeTool(call: ToolCall): Promise<{ content: string; moves: string[]; ok: boolean; error?: string; plan?: string | null; planProvided: boolean }> {
    const stateResult = () => {
      const s = describeState(this.state);
      return {
        moves_used: this.stats.moves,
        correct_stickers: `${s.correct}/${s.total}`,
        state: { encoding: s.encoding, size: s.size, net: s.net, faces: s.faces, state_hash: s.hash, move_count: this.stats.moves },
      };
    };
    const reject = (code: string, message: string, retryable = true, planProvided = false) => {
      this.stats.invalidToolCalls++;
      const result = {
        ok: false,
        solved: isSolved(this.state),
        applied_moves: [],
        executed: [],
        error: { code, message, retryable },
        ...stateResult(),
      };
      return { content: JSON.stringify(result), moves: [], ok: false, error: message, plan: null, planProvided };
    };
    if (call.name !== 'rotate_cube') return reject('UNKNOWN_TOOL', `未知工具 ${call.name}，只能调用 rotate_cube`);
    if (!call.args) return reject('INVALID_ARGUMENTS', call.argsError ?? '工具参数无法解析');
    const args = call.args as { moves?: unknown; plan?: unknown };
    const rawPlan = args.plan;
    const planProvided = rawPlan !== undefined;
    if (planProvided && typeof rawPlan !== 'string') return reject('INVALID_PLAN', 'plan 必须是字符串', true, true);
    const plan = planProvided ? rawPlan.trim().slice(0, MAX_PLAN_CHARS) : undefined;
    const raw = args.moves;
    const tokens = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/).filter(Boolean) : null;
    if (!tokens || !tokens.length) return reject('EMPTY_MOVES', 'moves 必须是非空数组，例如 ["R", "U\'"]', true, planProvided);
    if (tokens.length > this.run.limits.maxMovesPerCall) {
      return reject('TOO_MANY_MOVES', `单次最多 ${this.run.limits.maxMovesPerCall} 步，本次 ${tokens.length} 步，已拒绝`, true, planProvided);
    }
    const moves = tokens.map((t) => parseMove(t));
    const bad = tokens.filter((_, i) => !moves[i]);
    if (bad.length) return reject('INVALID_MOVE', `非法记号：${bad.join(' ')}，整次调用未执行`, true, planProvided);

    const executed: string[] = [];
    for (const m of moves as Move[]) {
      await this.checkpoint();
      this.state = applyMove(this.state, m);
      const token = formatAlg([m]);
      executed.push(token);
      this.stats.moves++;
      this.stats.qtm += quarterTurns(m);
      this.stats.lastMove = token;
      this.stats.correctStickers = correctStickers(this.state);
      const t = this.now();
      this.appendTrace({ t, type: 'move', move: token, index: this.stats.moves });
      this.run.emit({ type: 'move', cid: this.info.id, move: token, index: this.stats.moves, t });
      if (isSolved(this.state)) break;
    }
    const s = describeState(this.state);
    const solved = isSolved(this.state);
    return {
      content: JSON.stringify({
        ok: true,
        solved,
        error: null,
        applied_moves: executed,
        executed,
        moves_used: this.stats.moves,
        correct_stickers: `${s.correct}/${s.total}`,
        state: { encoding: s.encoding, size: s.size, net: s.net, faces: s.faces, state_hash: s.hash, move_count: this.stats.moves },
      }),
      moves: executed,
      ok: true,
      plan,
      planProvided,
    };
  }

  private rejectParallelToolCall(count: number): { content: string; moves: string[]; ok: boolean; error: string; plan: null; planProvided: boolean } {
    const s = describeState(this.state);
    const message = `单次 assistant 响应包含 ${count} 个工具调用；为避免基于旧状态串行执行，本轮未执行任何调用`;
    return {
      content: JSON.stringify({
        ok: false,
        solved: isSolved(this.state),
        applied_moves: [],
        executed: [],
        moves_used: this.stats.moves,
        correct_stickers: `${s.correct}/${s.total}`,
        state: { encoding: s.encoding, size: s.size, net: s.net, faces: s.faces, state_hash: s.hash, move_count: this.stats.moves },
        error: { code: 'PARALLEL_TOOL_CALLS_UNSUPPORTED', message, retryable: true },
      }),
      moves: [], ok: false, error: message, plan: null, planProvided: false,
    };
  }

  /** 当前 canonical state 是事实来源；每轮追加最新状态与原始协议块。 */
  private stateTurn(memory: TurnMemory): Turn {
    return { role: 'user', text: turnMessage(this.state, { ...memory, movesUsed: this.stats.moves }) };
  }

  async start() {
    try {
      await this.checkpoint();
    } catch (e) {
      if (e instanceof StopSignal || this.abort.signal.aborted) {
        this.setStatus('stopped', this.failReason ?? '排队时被停止');
        this.config = undefined;
        this.apiKey = undefined;
        return;
      }
      throw e;
    }
    if (this.queueExpired()) {
      this.setStatus('failed', `排队等待超过最大运行时间（${this.run.limits.maxDurationSec} 秒）`);
      this.config = undefined;
      this.apiKey = undefined;
      return;
    }
    const runAcquired = await this.acquireSlot(this.run.slots);
    if (!runAcquired) {
      this.setStatus(this.queueExpired() ? 'failed' : 'stopped', this.queueExpired() ? `排队等待超过最大运行时间（${this.run.limits.maxDurationSec} 秒）` : (this.failReason ?? '排队时被停止'));
      this.config = undefined;
      this.apiKey = undefined;
      return;
    }
    if (this.queueExpired()) {
      this.run.slots.release();
      this.setStatus('failed', `排队等待超过最大运行时间（${this.run.limits.maxDurationSec} 秒）`);
      this.config = undefined;
      this.apiKey = undefined;
      return;
    }
    const globalAcquired = await this.acquireSlot(globalSessions);
    if (!globalAcquired) {
      this.run.slots.release();
      this.setStatus(this.queueExpired() ? 'failed' : 'stopped', this.queueExpired() ? `排队等待超过最大运行时间（${this.run.limits.maxDurationSec} 秒）` : (this.failReason ?? '排队时被停止'));
      this.config = undefined;
      this.apiKey = undefined;
      return;
    }
    if (this.queueExpired()) {
      this.run.slots.release();
      globalSessions.release();
      this.setStatus('failed', `排队等待超过最大运行时间（${this.run.limits.maxDurationSec} 秒）`);
      this.config = undefined;
      this.apiKey = undefined;
      return;
    }
    try {
      await this.loop();
    } finally {
      this.config = undefined;
      this.apiKey = undefined;
      this.run.slots.release();
      globalSessions.release();
    }
  }

  private async loop() {
    const { limits } = this.run;
    const deadline = this.run.startedAt + limits.maxDurationSec * 1000;
    this.setStatus('running');
    const config = this.config!;
    const apiKey = this.apiKey;
    if (!apiKey && config.authMode !== 'none') {
      this.setStatus('error', '未设置 API Key');
      return;
    }
    const adapter = ADAPTERS[config.protocol];
    const endpoint = resolveEndpoint(config.protocol, config.baseUrl, this.model);
    const tools = [rotateCubeTool(limits, this.run.cubeSize)];
    const system = systemPrompt(limits, this.run.cubeSize);
    // 保留原始 assistant/tool 协议块，当前 canonical state 作为最新 user 事实追加。
    // 适配器负责把统一事件转换为供应商格式，不能在循环中重置历史。
    const recent: CallRecap[] = [];
    let plan: TurnMemory['plan'] = null;
    const remember = (r: CallRecap) => {
      recent.push(r);
      if (recent.length > RECENT_CALLS_SHOWN) recent.shift();
    };
    let turns: Turn[] = [this.stateTurn({ recent, plan })];
    const continueFrom = (
      result: TurnResult,
      toolResults: { callId: string; name: string; content: string }[],
      memory: TurnMemory,
    ) => {
      const nextStateTurn = this.stateTurn(memory);
      const assistantTurn: Turn = { role: 'assistant', text: result.text, toolCalls: result.toolCalls, raw: sanitizeReplayRaw(result.raw) };
      turns.push(assistantTurn);
      if (toolResults.length) turns.push({ role: 'tool', results: toolResults });
      turns.push(nextStateTurn);
    };
    // 上一轮没有调用工具时，下一次请求要求必须调用工具；供应商不支持时整局回退为 auto
    let forceTool = false;
    let canForceTool = true;
    let noToolStreak = 0;
    let noProgressStreak = 0;
    let invalidToolStreak = 0;
    let lastStateHash = describeState(this.state).hash;
    let historyCompactionLogged = false;
    const limiter = credentialLimiter(hostOf(endpoint), apiKey, config.maxConcurrentRequests);
    try {
      for (;;) {
        await this.checkpoint();
        const remainingMs = deadline - Date.now();
        if (this.stats.apiCalls >= limits.maxApiCalls) return this.setStatus('failed', `达到最大 API 调用次数（${limits.maxApiCalls}）`);
        if (remainingMs <= 0) return this.setStatus('failed', `达到最大运行时间（${limits.maxDurationSec} 秒）`);
        let result;
        let attempt = 0;
        for (;;) {
          await this.checkpoint();
          const requestRemainingMs = deadline - Date.now();
          if (this.stats.apiCalls >= limits.maxApiCalls) return this.setStatus('failed', `达到最大 API 调用次数（${limits.maxApiCalls}）`);
          if (requestRemainingMs <= 0) return this.setStatus('failed', `达到最大运行时间（${limits.maxDurationSec} 秒）`);
          // 等待同一密钥的并发名额时暂停计时：这是供应商的容量限制，不算模型用时
          if (limiter) {
            const ok = await this.acquireCredential(limiter);
            if (!ok) {
              if (this.queueExpired()) return this.setStatus('failed', `等待并发名额时超过最大运行时间（${limits.maxDurationSec} 秒）`);
              throw new StopSignal();
            }
            if (deadline - Date.now() <= 0) {
              limiter.release();
              return this.setStatus('failed', `达到最大运行时间（${limits.maxDurationSec} 秒）`);
            }
          }
          this.stats.apiCalls++;
          // 请求发出前立即同步计数，前端可在模型思考期间显示当前调用次数。
          this.emitStats();
          const started = Date.now();
          const toolChoice = forceTool && canForceTool ? 'required' : 'auto';
          try {
            const fixedContextChars = JSON.stringify({ system, tools }).length;
            const conversationBudget = limits.maxContextChars - fixedContextChars;
            if (conversationBudget <= 0) return this.setStatus('failed', `系统提示和工具定义已超过上下文预算（${limits.maxContextChars} 字符）`);
            const compacted = compactTurns(turns, limits.maxHistoryRounds, conversationBudget);
            turns = compacted.turns;
            if (compacted.droppedRounds > 0) {
              if (!historyCompactionLogged) {
                this.log('info', `已压缩 ${compacted.droppedRounds} 个较早协议回合，保留最近 ${limits.maxHistoryRounds} 轮和最新 canonical state`);
                historyCompactionLogged = true;
              }
            }
            if (compacted.overflow) return this.setStatus('failed', `最新协议回合超过上下文预算（${limits.maxContextChars} 字符）`);
            result = await adapter.call({
              config, model: this.model, reasoningEffort: this.effort, maxOutputTokens: this.maxOutputTokens,
              endpoint, apiKey, system, tools, turns,
              toolChoice, signal: this.abort.signal,
              timeoutMs: Math.min(requestRemainingMs, limits.requestTimeoutSec * 1000),
              deadlineMs: deadline,
            });
            if (result.forcedToolSupported === false) canForceTool = false;
            this.stats.lastLatencyMs = Date.now() - started;
            this.stats.apiLatencyMs += this.stats.lastLatencyMs;
            break;
          } catch (e) {
            this.stats.lastLatencyMs = Date.now() - started;
            this.stats.apiLatencyMs += this.stats.lastLatencyMs;
            if (this.abort.signal.aborted) throw new StopSignal();
            if (e instanceof DeadlineExceededError) return this.setStatus('failed', `达到最大运行时间（${limits.maxDurationSec} 秒）`);
            const err = e instanceof ProviderError ? e : new ProviderError('network', '请求失败');
            this.recordCall(null, [], { error: err.message });
            if (deadline - Date.now() <= 0) return this.setStatus('failed', `达到最大运行时间（${limits.maxDurationSec} 秒）`);
            // 模型不支持某个可选参数：去掉该参数重试，并明确记录（不计入预算）
            const rejected = rejectedOptionalParam(err, { effort: this.effort !== 'default', forcedTool: toolChoice === 'required' });
            if (rejected) {
              this.stats.apiCalls--;
              if (rejected === 'effort') {
                this.stats.effortIgnored = true;
                this.log('warn', `该模型不接受推理强度参数（${err.message}），已改为默认推理强度继续`);
                this.effort = 'default';
              } else {
                canForceTool = false;
                this.log('warn', `该模型不支持强制工具调用（${err.message}），之后只使用 tool_choice=auto`);
              }
              continue;
            }
            const throttled = err.status === 429;
            const transient = err.kind === 'network' || err.kind === 'timeout' || (err.status ?? 0) >= 500;
            if (throttled) {
              // 被限流的请求没有产生用量，也不计入模型的 API 调用预算
              this.stats.apiCalls--;
              this.stats.throttledCalls++;
            } else if (transient) {
              // 超时、网关错误时上游可能已经计费，用量未知
              this.stats.usageMissingCalls++;
            }
            this.emitStats();
            const maxAttempts = throttled ? MAX_THROTTLE_RETRIES : MAX_RETRIES;
            if ((throttled || transient) && attempt < maxAttempts) {
              attempt++;
              const backoff = Math.min(30_000, 2000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
              const delay = Math.round(err.retryAfterMs ?? backoff);
              this.log('warn', `${err.message}，${(delay / 1000).toFixed(1)} 秒后重试（第 ${attempt}/${maxAttempts} 次）`);
              const waitMs = Math.min(delay, Math.max(0, deadline - Date.now()));
              await abortableDelay(waitMs, this.abort.signal);
              await this.checkpoint();
              continue;
            }
            throw err;
          } finally {
            // 每次请求结束即归还名额，退避等待期间不占用
            limiter?.release();
          }
        }

        this.addUsage(result.usage);
        if (result.truncated) {
          this.log('warn', `第 ${this.stats.apiCalls} 次调用的输出达到最大输出 Token 上限被截断${result.toolCalls.length ? '' : '，没有形成工具调用'}`);
        }

        const n = this.stats.apiCalls;
        if (!result.toolCalls.length) {
          this.recordCall(result, []);
          this.emitStats();
          noToolStreak++;
          if (noToolStreak >= limits.maxNoToolCalls) return this.setStatus('failed', `连续 ${limits.maxNoToolCalls} 次未调用工具`);
          forceTool = true;
          remember({ n, moves: [], error: '未调用工具' });
          continueFrom(
            result,
            [],
            { recent, plan, notes: result.truncated ? [TRUNCATED_NOTE, NO_TOOL_NUDGE] : [NO_TOOL_NUDGE] },
          );
          continue;
        }
        noToolStreak = 0;
        forceTool = false;
        const summaries: { moves: string[]; ok: boolean; error?: string }[] = [];
        const toolResults: { callId: string; name: string; content: string }[] = [];
        let newPlan: string | undefined;
        let planSeen = false;
        const calls = result.toolCalls.length > 1 ? result.toolCalls.map(() => null) : result.toolCalls;
        for (const call of calls) {
          if (!call) {
            const r = this.rejectParallelToolCall(result.toolCalls.length);
            this.stats.invalidToolCalls++;
            this.stats.toolCalls++;
            summaries.push({ moves: [], ok: false, error: r.error });
            toolResults.push({ callId: result.toolCalls[summaries.length - 1].id, name: result.toolCalls[summaries.length - 1].name || 'rotate_cube', content: r.content });
            continue;
          }
          this.stats.toolCalls++;
          // 必须回复每一个工具调用；复原后或达到上限时，剩余调用不再执行
          const blocked = isSolved(this.state) ? '魔方已复原，未执行' : null;
          const r = blocked
            ? (() => {
                const s = describeState(this.state);
                return {
                  content: JSON.stringify({
                    ok: false,
                    solved: true,
                    applied_moves: [],
                    executed: [],
                    moves_used: this.stats.moves,
                    correct_stickers: `${s.correct}/${s.total}`,
                    state: { encoding: s.encoding, size: s.size, net: s.net, faces: s.faces, state_hash: s.hash, move_count: this.stats.moves },
                    error: { code: 'ALREADY_SOLVED', message: blocked, retryable: false },
                  }),
                  moves: [], ok: false, error: blocked, plan: null, planProvided: false,
                };
              })()
            : await this.executeTool(call);
          summaries.push({ moves: r.moves, ok: r.ok, error: r.error });
          toolResults.push({ callId: call.id, name: call.name, content: r.content });
          if (r.planProvided) {
            planSeen = true;
            newPlan = r.plan ?? undefined;
          }
        }
        this.recordCall(result, summaries, { plan: newPlan });
        this.emitStats();
        if (isSolved(this.state)) return this.setStatus('solved');

        if (planSeen) plan = newPlan ? { n, text: newPlan } : null;
        else plan = null;
        const rejected = summaries.filter((s) => !s.ok).map((s) => s.error ?? '未知错误');
        invalidToolStreak = summaries.length > 0 && summaries.every((s) => !s.ok) ? invalidToolStreak + 1 : 0;
        if (invalidToolStreak >= limits.maxNoProgressCalls) return this.setStatus('failed', `连续 ${limits.maxNoProgressCalls} 次工具调用无效`);
        const currentStateHash = describeState(this.state).hash;
        if (currentStateHash === lastStateHash) noProgressStreak++;
        else noProgressStreak = 0;
        lastStateHash = currentStateHash;
        if (noProgressStreak >= limits.maxNoProgressCalls) return this.setStatus('failed', `连续 ${limits.maxNoProgressCalls} 次状态没有变化`);
        remember({ n, moves: summaries.flatMap((s) => s.moves), error: rejected.join('；') || undefined });
        continueFrom(result, toolResults, { recent, plan, notes: result.truncated ? [TRUNCATED_NOTE] : [] });
      }
    } catch (e) {
      if (e instanceof StopSignal || this.abort.signal.aborted) return this.setStatus('stopped', this.failReason ?? '已手动停止');
      const msg = e instanceof ProviderError ? e.message : redact(String((e as Error)?.message ?? e), [apiKey]);
      this.setStatus('error', msg);
    }
  }

  /** result 为 null 表示请求失败 */
  private recordCall(
    result: TurnResult | null,
    tools: { moves: string[]; ok: boolean; error?: string }[],
    { error, plan }: { error?: string; plan?: string } = {},
  ) {
    const usage = result?.usage;
    const item = {
      t: this.now(),
      type: 'call' as const,
      n: this.stats.apiCalls,
      latencyMs: this.stats.lastLatencyMs ?? 0,
      text: result?.text.slice(0, 2000) ?? '',
      reasoning: result?.reasoning ? clipMiddle(result.reasoning, MAX_TRACE_REASONING) : undefined,
      truncated: result?.truncated || undefined,
      plan,
      tools,
      usage: usage ? { input: usage.input, output: usage.output, reasoning: usage.reasoning } : undefined,
      outcome: error ? 'error' as const : 'success' as const,
      error,
    };
    this.appendTrace(item);
    this.run.emit({ type: 'call', cid: this.info.id, item });
  }
}

type Listener = (e: RunEventEnvelope) => void;

export class Run {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  readonly startedAt = Date.now();
  readonly scramble: Move[];
  readonly initialState: CubeState;
  readonly contestants: Contestant[];
  readonly slots: Semaphore;
  readonly events: RunEventEnvelope[] = [];
  status: 'running' | 'finished' = 'running';
  finishedAt: string | null = null;
  reportIncomplete = false;
  private doneEmitted = false;
  private eventSeq = 0;
  private listeners = new Set<Listener>();

  constructor(
    entries: ContestantEntry[],
    readonly difficulty: Difficulty,
    readonly limits: RunLimits,
    readonly cubeSize: number = 3,
    readonly ownerId?: string,
  ) {
    // 服务端只打乱一次，所有选手共享同一个（不可变的）初始状态
    this.scramble = randomScramble(difficulty.scrambleLength, Math.random, cubeSize);
    this.initialState = Object.freeze(this.scramble.reduce(applyMove, solvedState(cubeSize))) as CubeState;
    this.slots = new Semaphore(Math.max(1, Math.floor(limits.concurrency)));
    this.contestants = entries.map((e) => new Contestant(this, e));
    this.emit({ type: 'init', run: this.publicSummary() });
  }

  summary(): RunSummary {
    return {
      id: this.id,
      ownerId: this.ownerId,
      createdAt: this.createdAt,
      difficulty: this.difficulty.id,
      cubeSize: this.cubeSize,
      scrambleLength: this.difficulty.scrambleLength,
      finishedAt: this.finishedAt ?? undefined,
      reportIncomplete: this.reportIncomplete || undefined,
      scramble: formatAlg(this.scramble),
      initialState: this.initialState.join(''),
      limits: this.limits,
      status: this.status,
      contestants: this.contestants.map((c) => c.snapshot()),
    };
  }

  publicSummary(): PublicRunSummary {
    const { scramble: _scramble, initialState: _initialState, ownerId: _ownerId, ...publicSummary } = this.summary();
    return publicSummary;
  }

  record(): RunRecord {
    return { ...this.summary(), traces: Object.fromEntries(this.contestants.map((c) => [c.info.id, c.trace])) };
  }

  publicRecord(): PublicRunRecord {
    const traces = Object.fromEntries(this.contestants.map((c) => [c.info.id, c.trace.map((item) => {
      if (item.type !== 'call' || !('reasoning' in item)) return item;
      const { reasoning: _reasoning, ...publicItem } = item;
      return publicItem;
    })]));
    return { ...this.publicSummary(), traces };
  }

  reportRecord(): RunRecord {
    const traces = this.reportIncomplete ? {} : Object.fromEntries(this.contestants.map((c) => [c.info.id, c.trace.map((item) => {
      if (item.type !== 'call' || !('reasoning' in item)) return item;
      const { reasoning: _reasoning, ...reportItem } = item;
      return reportItem;
    })]));
    return { ...this.summary(), traces };
  }

  emit(e: RunEvent) {
    const envelope = { seq: ++this.eventSeq, event: e } satisfies RunEventEnvelope;
    if (this.events.length >= MAX_RUN_EVENTS) this.events.shift();
    this.events.push(envelope);
    for (const fn of this.listeners) fn(envelope);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 原子化地建立订阅并回放快照；回放期间产生的事件按 seq 排到快照之后。 */
  subscribeAndReplay(afterSeq: number, fn: Listener) {
    const snapshot = this.events.slice();
    let replaying = true;
    const pending: RunEventEnvelope[] = [];
    const listener: Listener = (envelope) => {
      if (envelope.seq <= afterSeq) return;
      if (replaying) pending.push(envelope);
      else fn(envelope);
    };
    this.listeners.add(listener);
    for (const envelope of snapshot) listener(envelope);
    replaying = false;
    pending.sort((a, b) => a.seq - b.seq).forEach(fn);
    return () => this.listeners.delete(listener);
  }

  get done() {
    return this.doneEmitted;
  }

  contestant(cid: string) {
    return this.contestants.find((c) => c.info.id === cid);
  }

  stopAll() {
    for (const c of this.contestants) c.stop('已终止全部测试');
  }

  pauseAll() {
    for (const c of this.contestants) c.pause();
  }

  resumeAll() {
    for (const c of this.contestants) c.resume();
  }

  /** 所有选手真正并发启动（受并发上限约束），互不等待、互不影响 */
  async start() {
    await Promise.allSettled(this.contestants.map((c) => c.start()));
    this.status = 'finished';
    this.finishedAt = new Date().toISOString();
    await saveRun(this.reportRecord()).then((incomplete) => { this.reportIncomplete ||= incomplete; }).catch((e) => {
      this.reportIncomplete = true;
      console.error('评测报告未完整保存：', (e as Error).message);
    });
    this.emit({ type: 'done', run: this.publicSummary() });
    this.doneEmitted = true;
    this.listeners.clear();
  }
}

export const runs = new Map<string, Run>();

setInterval(() => {
  for (const [id, r] of runs) {
    if (r.status === 'finished' && Date.now() - r.startedAt > 3600_000) runs.delete(id);
  }
}, 600_000).unref();
