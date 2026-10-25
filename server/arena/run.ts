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
import type { ToolCall, Turn } from '../adapters/types.ts';
import { getApiKey } from '../providers/store.ts';
import { redact } from '../security/redact.ts';
import { describeState, initialUserMessage, NO_TOOL_NUDGE, rotateCubeTool, systemPrompt } from './prompt.ts';
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
/** 推理强度参数被拒绝时，上游错误信息通常会提到这些字段 */
const EFFORT_REJECT_RE = /reasoning|effort|thinking|budget|unrecognized|unknown (field|param)|unsupported|not support|extra (fields|inputs)/i;

export interface ContestantEntry {
  config: ProviderConfig;
  model: string;
  reasoningEffort: ReasoningEffort;
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

  private readonly config: ProviderConfig;
  private readonly model: string;
  /** 推理强度；被模型拒绝后降级为 default 继续 */
  private effort: ReasoningEffort;

  constructor(
    private readonly run: Run,
    entry: ContestantEntry,
  ) {
    this.config = entry.config;
    this.model = entry.model;
    this.effort = entry.reasoningEffort;
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

  /** 执行一次 rotate_cube 调用，返回给模型的工具结果 */
  private async executeTool(call: ToolCall): Promise<{ content: string; moves: string[]; ok: boolean; error?: string }> {
    const reject = (error: string) => {
      this.stats.invalidToolCalls++;
      return { content: JSON.stringify({ ok: false, error, executed: [] }), moves: [], ok: false, error };
    };
    if (call.name !== 'rotate_cube') return reject(`未知工具 ${call.name}，只能调用 rotate_cube`);
    if (!call.args) return reject(call.argsError ?? '工具参数无法解析');
    const raw = (call.args as { moves?: unknown }).moves;
    const tokens = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/).filter(Boolean) : null;
    if (!tokens || !tokens.length) return reject('moves 必须是非空数组，例如 ["R", "U\'"]');
    const { limits } = this.run;
    if (tokens.length > limits.maxMovesPerCall) return reject(`单次最多 ${limits.maxMovesPerCall} 步，本次 ${tokens.length} 步，已拒绝`);
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

  /**
   * 每次模型请求都从当前状态重新开始一轮短上下文。
   * 魔方状态已经包含此前所有动作的结果，继续回放 assistant 的
   * reasoning_content / tool_calls 会让供应商在每轮重复计费整段历史。
   */
  private stateTurn(feedback = ''): Turn {
    const text = feedback ? `${initialUserMessage(this.state)}\n\n${feedback}` : initialUserMessage(this.state);
    return { role: 'user', text };
  }

  async start() {
    const acquired = (await this.run.slots.acquire(this.abort.signal)) && (await globalSessions.acquire(this.abort.signal));
    if (!acquired) {
      this.setStatus('stopped', this.failReason ?? '排队时被停止');
      return;
    }
    try {
      await this.loop();
    } finally {
      this.run.slots.release();
      globalSessions.release();
    }
  }

  private async loop() {
    const { limits } = this.run;
    this.setStatus('running');
    const apiKey = await getApiKey(this.config.id);
    if (!apiKey && this.config.authMode !== 'none') {
      this.setStatus('error', '未设置 API Key（服务重启后，未加密保存的密钥需要重新输入）');
      return;
    }
    const adapter = ADAPTERS[this.config.protocol];
    const endpoint = resolveEndpoint(this.config.protocol, this.config.baseUrl, this.model);
    const tools = [rotateCubeTool(limits)];
    const system = systemPrompt(limits, this.run.cubeSize);
    // 不把上一轮的 assistant/tool 历史带回供应商；当前状态是完整事实来源。
    let turns: Turn[] = [this.stateTurn()];
    const limiter = credentialLimiter(hostOf(endpoint), apiKey, this.config.maxConcurrentRequests);
    try {
      for (;;) {
        await this.checkpoint();
        let result;
        let attempt = 0;
        for (;;) {
          // 等待同一密钥的并发名额时暂停计时：这是供应商的容量限制，不算模型用时
          if (limiter) {
            this.clockStop();
            const ok = await limiter.acquire(this.abort.signal);
            this.clockStart();
            if (!ok) throw new StopSignal();
          }
          this.stats.apiCalls++;
          const started = Date.now();
          try {
            result = await adapter.call({
              config: this.config, model: this.model, reasoningEffort: this.effort,
              endpoint, apiKey, system, tools, turns,
              toolChoice: 'auto', signal: this.abort.signal, timeoutMs: null,
            });
            this.stats.lastLatencyMs = Date.now() - started;
            this.stats.apiLatencyMs += this.stats.lastLatencyMs;
            break;
          } catch (e) {
            this.stats.lastLatencyMs = Date.now() - started;
            this.stats.apiLatencyMs += this.stats.lastLatencyMs;
            if (this.abort.signal.aborted) throw new StopSignal();
            const err = e instanceof ProviderError ? e : new ProviderError('network', '请求失败');
            this.recordCall('', [], null, err.message);
            // 模型不支持推理强度参数：去掉该参数重试一次，并明确记录（不计入预算）
            if (this.effort !== 'default' && err.status === 400 && EFFORT_REJECT_RE.test(err.message)) {
              this.stats.apiCalls--;
              this.stats.effortIgnored = true;
              this.log('warn', `该模型不接受推理强度参数（${err.message}），已改为默认推理强度继续`);
              this.effort = 'default';
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
              await new Promise((r) => setTimeout(r, delay));
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
        if (!result.toolCalls.length) {
          this.recordCall(result.text, [], result.usage);
          this.emitStats();
          turns = [this.stateTurn(NO_TOOL_NUDGE)];
          continue;
        }
        const summaries: { moves: string[]; ok: boolean; error?: string }[] = [];
        for (const call of result.toolCalls) {
          this.stats.toolCalls++;
          // 必须回复每一个工具调用；复原后或达到上限时，剩余调用不再执行
          const blocked = isSolved(this.state) ? '魔方已复原，未执行' : null;
          const r = blocked
            ? { content: JSON.stringify({ ok: false, error: blocked, executed: [] }), moves: [], ok: false, error: blocked }
            : await this.executeTool(call);
          summaries.push({ moves: r.moves, ok: r.ok, error: r.error });
        }
        this.recordCall(result.text, summaries, result.usage);
        this.emitStats();
        if (isSolved(this.state)) return this.setStatus('solved');

        const feedback = summaries.map((s) => {
          if (s.ok) return `已执行：${s.moves.join(' ') || '无'}`;
          return `工具调用未执行：${s.error ?? '未知错误'}`;
        }).join('\n');
        turns = [this.stateTurn(`上一轮工具执行摘要：\n${feedback}\n请继续调用 rotate_cube。`)];
      }
    } catch (e) {
      if (e instanceof StopSignal || this.abort.signal.aborted) return this.setStatus('stopped', this.failReason ?? '已手动停止');
      const msg = e instanceof ProviderError ? e.message : redact(String((e as Error)?.message ?? e), [apiKey]);
      this.setStatus('error', msg);
    }
  }

  private recordCall(
    text: string,
    tools: { moves: string[]; ok: boolean; error?: string }[],
    usage: { input: number | null; output: number | null; reasoning: number | null } | null,
    error?: string,
  ) {
    const item = {
      t: this.now(),
      type: 'call' as const,
      n: this.stats.apiCalls,
      latencyMs: this.stats.lastLatencyMs ?? 0,
      text: text.slice(0, 2000),
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
    this.slots = new Semaphore(Number.POSITIVE_INFINITY);
    this.contestants = entries.map((e) => new Contestant(this, e));
    this.emit({ type: 'init', run: this.summary() });
  }

  summary(): RunSummary {
    return {
      id: this.id,
      createdAt: this.createdAt,
      difficulty: this.difficulty.id,
      cubeSize: this.cubeSize,
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

  /** 所有选手真正并发启动（受并发上限约束），互不等待、互不影响 */
  async start() {
    await Promise.allSettled(this.contestants.map((c) => c.start()));
    this.status = 'finished';
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
