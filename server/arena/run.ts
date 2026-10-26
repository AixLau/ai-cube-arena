import { createHash, randomUUID } from 'node:crypto';
import {
  applyMove, correctStickers, formatAlg, isSolved, parseMove, quarterTurns, randomScramble,
  solvedState, type CubeState, type Move,
} from '../../shared/cube.ts';
import { hostOf, resolveEndpoint } from '../../shared/endpoint.ts';
import {
  TERMINAL_STATUSES, type ContestantInfo, type ContestantState, type ContestantStats, type ContestantStatus,
  type Difficulty, type ProviderConfig, type ReasoningEffort, type RunEvent, type RunLimits, type RunRecord, type RunSummary, type TraceItem,
} from '../../shared/types.ts';
import { ADAPTERS } from '../adapters/index.ts';
import { ProviderError } from '../adapters/http.ts';
import type { ToolCall, Turn, TurnResult } from '../adapters/types.ts';
import { redact } from '../security/redact.ts';
import {
  describeState, MAX_PLAN_CHARS, NO_TOOL_NUDGE, RECENT_CALLS_SHOWN, rotateCubeTool, systemPrompt, TRUNCATED_NOTE, turnMessage,
  type CallRecap, type TurnMemory,
} from './prompt.ts';
import { saveRun } from './store.ts';

/** 简单的计数信号量，用于单局并发与全局并发控制 */
export class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private free: number) {}
  async acquire(signal?: AbortSignal): Promise<boolean> {
    if (this.free > 0) {
      this.free--;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => resolve(true);
      this.waiters.push(grant);
      signal?.addEventListener('abort', () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(false);
        }
      }, { once: true });
    });
  }
  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

/** 全局同时进行的模型会话上限，防止供应商限流与服务端过载 */
export const globalSessions = new Semaphore(Number(process.env.MAX_ACTIVE_SESSIONS || 16));

/** 同一密钥 + 同一主机共享的请求并发上限（键为哈希，内存中也不保存密钥原文） */
const credentialLimiters = new Map<string, Semaphore>();
function credentialLimiter(host: string, apiKey: string | undefined, limit: number | null): Semaphore | null {
  if (!limit) return null;
  const key = createHash('sha256').update(`${host}\0${apiKey ?? ''}`).digest('hex');
  let sem = credentialLimiters.get(key);
  if (!sem) credentialLimiters.set(key, (sem = new Semaphore(limit)));
  return sem;
}

/** 网络错误、超时、5xx 的重试次数（计入 API 调用预算） */
const MAX_RETRIES = 2;
/** 限流（429）的重试次数（不计入预算，但受最大运行时间约束） */
const MAX_THROTTLE_RETRIES = 8;
const EFFORT_PARAM_RE = /reasoning|effort|thinking|budget/i;
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
  if (sent.effort && (EFFORT_PARAM_RE.test(m) || generic)) return 'effort';
  return null;
}

/** 思考内容可能很长：保留开头与结尾（结论通常在末尾），控制事件与记录体积 */
const MAX_TRACE_REASONING = 4000;
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
  private resumeWaiters: (() => void)[] = [];
  private activeSince: number | null = null;

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
    this.trace.push({ t, type: 'status', status, reason: reason ?? undefined });
    this.run.emit({ type: 'status', cid: this.info.id, status, reason, t });
    this.emitStats();
  }

  private emitStats() {
    this.run.emit({ type: 'stats', cid: this.info.id, stats: { ...this.stats, durationMs: this.elapsed() } });
  }

  private log(level: 'info' | 'warn' | 'error', text: string) {
    const t = this.now();
    this.trace.push({ t, type: 'log', level, text });
    this.run.emit({ type: 'log', cid: this.info.id, level, text, t });
  }

  pause() {
    if (this.status !== 'running') return false;
    this.paused = true;
    this.setStatus('paused');
    return true;
  }

  resume() {
    if (this.status !== 'paused') return false;
    this.paused = false;
    this.setStatus('running');
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
  private async executeTool(call: ToolCall): Promise<{ content: string; moves: string[]; ok: boolean; error?: string }> {
    const stateResult = () => {
      const s = describeState(this.state);
      return { moves_used: this.stats.moves, correct_stickers: `${s.correct}/${s.total}`, state: { net: s.net, faces: s.faces } };
    };
    const reject = (error: string) => {
      this.stats.invalidToolCalls++;
      return { content: JSON.stringify({ ok: false, error, executed: [], ...stateResult() }), moves: [], ok: false, error };
    };
    if (call.name !== 'rotate_cube') return reject(`未知工具 ${call.name}，只能调用 rotate_cube`);
    if (!call.args) return reject(call.argsError ?? '工具参数无法解析');
    const raw = (call.args as { moves?: unknown }).moves;
    const tokens = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/).filter(Boolean) : null;
    if (!tokens || !tokens.length) return reject('moves 必须是非空数组，例如 ["R", "U\'"]');
    if (tokens.length > this.run.limits.maxMovesPerCall) {
      return reject(`单次最多 ${this.run.limits.maxMovesPerCall} 步，本次 ${tokens.length} 步，已拒绝`);
    }
    const moves = tokens.map((t) => parseMove(t));
    const bad = tokens.filter((_, i) => !moves[i]);
    if (bad.length) return reject(`非法记号：${bad.join(' ')}，整次调用未执行`);

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
      this.trace.push({ t, type: 'move', move: token, index: this.stats.moves });
      this.run.emit({ type: 'move', cid: this.info.id, move: token, index: this.stats.moves, t });
      if (isSolved(this.state)) break;
    }
    const s = describeState(this.state);
    const solved = isSolved(this.state);
    return {
      content: JSON.stringify({
        ok: true,
        executed,
        solved,
        moves_used: this.stats.moves,
        correct_stickers: `${s.correct}/${s.total}`,
        state: { net: s.net, faces: s.faces },
      }),
      moves: executed,
      ok: true,
    };
  }

  /** 当前状态是事实来源；调用循环只回放上一轮协议交互，避免历史线性增长。 */
  private stateTurn(memory: TurnMemory): Turn {
    return { role: 'user', text: turnMessage(this.state, memory) };
  }

  async start() {
    const runAcquired = await this.run.slots.acquire(this.abort.signal);
    if (!runAcquired) {
      this.setStatus('stopped', this.failReason ?? '排队时被停止');
      this.config = undefined;
      this.apiKey = undefined;
      return;
    }
    const globalAcquired = await globalSessions.acquire(this.abort.signal);
    if (!globalAcquired) {
      this.run.slots.release();
      this.setStatus('stopped', this.failReason ?? '排队时被停止');
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
    // 只保留上一轮交互，避免完整历史线性增长，同时让推理模型能沿用刚完成的工具调用上下文。
    const recent: CallRecap[] = [];
    let plan: TurnMemory['plan'] = null;
    const remember = (r: CallRecap) => {
      recent.push(r);
      if (recent.length > RECENT_CALLS_SHOWN) recent.shift();
    };
    let previousStateTurn: Turn = this.stateTurn({ recent, plan });
    let turns: Turn[] = [previousStateTurn];
    const continueFrom = (
      result: TurnResult,
      toolResults: { callId: string; name: string; content: string }[],
      memory: TurnMemory,
    ) => {
      const nextStateTurn = this.stateTurn(memory);
      const assistantTurn: Turn = { role: 'assistant', text: result.text, toolCalls: result.toolCalls, raw: result.raw };
      turns = [
        previousStateTurn,
        assistantTurn,
        ...(toolResults.length ? [{ role: 'tool', results: toolResults } satisfies Turn] : []),
        nextStateTurn,
      ];
      previousStateTurn = nextStateTurn;
    };
    // 上一轮没有调用工具时，下一次请求要求必须调用工具；供应商不支持时整局回退为 auto
    let forceTool = false;
    let canForceTool = true;
    let noToolStreak = 0;
    let invalidToolStreak = 0;
    const limiter = credentialLimiter(hostOf(endpoint), apiKey, config.maxConcurrentRequests);
    try {
      for (;;) {
        await this.checkpoint();
        const remainingMs = limits.maxDurationSec * 1000 - this.elapsed();
        if (this.stats.apiCalls >= limits.maxApiCalls) return this.setStatus('failed', `达到最大 API 调用次数（${limits.maxApiCalls}）`);
        if (remainingMs <= 0) return this.setStatus('failed', `达到最大运行时间（${limits.maxDurationSec} 秒）`);
        let result;
        let attempt = 0;
        for (;;) {
          await this.checkpoint();
          const requestRemainingMs = limits.maxDurationSec * 1000 - this.elapsed();
          if (this.stats.apiCalls >= limits.maxApiCalls) return this.setStatus('failed', `达到最大 API 调用次数（${limits.maxApiCalls}）`);
          if (requestRemainingMs <= 0) return this.setStatus('failed', `达到最大运行时间（${limits.maxDurationSec} 秒）`);
          // 等待同一密钥的并发名额时暂停计时：这是供应商的容量限制，不算模型用时
          if (limiter) {
            this.clockStop();
            const ok = await limiter.acquire(this.abort.signal);
            this.clockStart();
            if (!ok) throw new StopSignal();
          }
          this.stats.apiCalls++;
          // 请求发出前立即同步计数，前端可在模型思考期间显示当前调用次数。
          this.emitStats();
          const started = Date.now();
          const toolChoice = forceTool && canForceTool ? 'required' : 'auto';
          try {
            result = await adapter.call({
              config, model: this.model, reasoningEffort: this.effort, maxOutputTokens: this.maxOutputTokens,
              endpoint, apiKey, system, tools, turns,
              toolChoice, signal: this.abort.signal,
              timeoutMs: Math.min(requestRemainingMs, limits.requestTimeoutSec * 1000),
            });
            this.stats.lastLatencyMs = Date.now() - started;
            this.stats.apiLatencyMs += this.stats.lastLatencyMs;
            break;
          } catch (e) {
            this.stats.lastLatencyMs = Date.now() - started;
            this.stats.apiLatencyMs += this.stats.lastLatencyMs;
            if (this.abort.signal.aborted) throw new StopSignal();
            const err = e instanceof ProviderError ? e : new ProviderError('network', '请求失败');
            this.recordCall(null, [], { error: err.message });
            if (limits.maxDurationSec * 1000 - this.elapsed() <= 0) return this.setStatus('failed', `达到最大运行时间（${limits.maxDurationSec} 秒）`);
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
              const waitMs = Math.min(delay, Math.max(0, limits.maxDurationSec * 1000 - this.elapsed()));
              await new Promise((r) => setTimeout(r, waitMs));
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
          if (noToolStreak >= 3) return this.setStatus('failed', '连续 3 次未调用工具');
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
        for (const call of result.toolCalls) {
          this.stats.toolCalls++;
          // 必须回复每一个工具调用；复原后或达到上限时，剩余调用不再执行
          const blocked = isSolved(this.state) ? '魔方已复原，未执行' : null;
          const r = blocked
            ? (() => {
                const s = describeState(this.state);
                return {
                  content: JSON.stringify({ ok: false, error: blocked, executed: [], moves_used: this.stats.moves, correct_stickers: `${s.correct}/${s.total}`, state: { net: s.net, faces: s.faces } }),
                  moves: [], ok: false, error: blocked,
                };
              })()
            : await this.executeTool(call);
          summaries.push({ moves: r.moves, ok: r.ok, error: r.error });
          toolResults.push({ callId: call.id, name: call.name, content: r.content });
          const p = (call.args as { plan?: unknown } | null)?.plan;
          if (typeof p === 'string' && p.trim()) newPlan = p.trim().slice(0, MAX_PLAN_CHARS);
        }
        this.recordCall(result, summaries, { plan: newPlan });
        this.emitStats();
        if (isSolved(this.state)) return this.setStatus('solved');

        if (newPlan) plan = { n, text: newPlan };
        const rejected = summaries.filter((s) => !s.ok).map((s) => s.error ?? '未知错误');
        invalidToolStreak = summaries.length > 0 && summaries.every((s) => !s.ok) ? invalidToolStreak + 1 : 0;
        if (invalidToolStreak >= 3) return this.setStatus('failed', '连续 3 次工具调用无效');
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
    this.trace.push(item);
    this.run.emit({ type: 'call', cid: this.info.id, item });
  }
}

type Listener = (e: RunEvent) => void;

export class Run {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  readonly startedAt = Date.now();
  readonly scramble: Move[];
  readonly initialState: CubeState;
  readonly contestants: Contestant[];
  readonly slots: Semaphore;
  readonly events: RunEvent[] = [];
  status: 'running' | 'finished' = 'running';
  finishedAt: string | null = null;
  private listeners = new Set<Listener>();

  constructor(
    entries: ContestantEntry[],
    readonly difficulty: Difficulty,
    readonly limits: RunLimits,
    readonly cubeSize: number = 3,
  ) {
    // 服务端只打乱一次，所有选手共享同一个（不可变的）初始状态
    this.scramble = randomScramble(difficulty.scrambleLength, Math.random, cubeSize);
    this.initialState = Object.freeze(this.scramble.reduce(applyMove, solvedState(cubeSize))) as CubeState;
    this.slots = new Semaphore(Math.max(1, Math.floor(limits.concurrency)));
    this.contestants = entries.map((e) => new Contestant(this, e));
    this.emit({ type: 'init', run: this.summary() });
  }

  summary(): RunSummary {
    return {
      id: this.id,
      createdAt: this.createdAt,
      difficulty: this.difficulty.id,
      cubeSize: this.cubeSize,
      scrambleLength: this.difficulty.scrambleLength,
      finishedAt: this.finishedAt ?? undefined,
      scramble: formatAlg(this.scramble),
      initialState: this.initialState.join(''),
      limits: this.limits,
      status: this.status,
      contestants: this.contestants.map((c) => c.snapshot()),
    };
  }

  record(): RunRecord {
    return { ...this.summary(), traces: Object.fromEntries(this.contestants.map((c) => [c.info.id, c.trace])) };
  }

  emit(e: RunEvent) {
    this.events.push(e);
    for (const fn of this.listeners) fn(e);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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
    await saveRun(this.record()).catch((e) => console.error('保存评测记录失败：', (e as Error).message));
    this.emit({ type: 'done', run: this.summary() });
    this.listeners.clear();
  }
}

export const runs = new Map<string, Run>();

setInterval(() => {
  for (const [id, r] of runs) {
    if (r.status === 'finished' && Date.now() - r.startedAt > 3600_000) runs.delete(id);
  }
}, 600_000).unref();
