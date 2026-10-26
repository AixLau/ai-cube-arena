import 'dotenv/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  CUBE_SIZE_INFO, DEFAULT_LIMITS, DIFFICULTIES, MAX_SCRAMBLE_LENGTH, PROTOCOLS, REASONING_EFFORTS, TERMINAL_STATUSES, type RunEntry, type RunEventEnvelope, type RunLimits,
} from '../shared/types.ts';
import { STATE_ENCODING } from './arena/prompt.ts';
import { Run, runs, type ContestantEntry } from './arena/run.ts';
import { listRuns, loadRun } from './arena/store.ts';
import {
  DraftError, modelsOf, normalizeProvider, refreshProvider, validateApiKey,
} from './providers/store.ts';
import { testConnection } from './providers/test.ts';

export const app = express();
app.disable('x-powered-by');

// 正式部署：REQUIRE_HTTPS=true 时拒绝明文请求（反向代理需传递 X-Forwarded-Proto）
if (process.env.REQUIRE_HTTPS === 'true') {
  app.set('trust proxy', process.env.TRUST_PROXY || 1);
  app.use((req, res, next) => {
    if (req.secure) return next();
    if (req.method === 'GET' && !req.path.startsWith('/api')) return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    res.status(403).json({ error: '请通过 HTTPS 访问' });
  });
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '1mb' }));

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

function stripReasoning<T extends { traces: Record<string, any[]> }>(record: T): T {
  const traces = Object.fromEntries(Object.entries(record.traces).map(([cid, items]) => [cid, items.map((item) => {
    if (item?.type !== 'call' || !('reasoning' in item)) return item;
    const { reasoning: _reasoning, ...publicItem } = item;
    return publicItem;
  })]));
  return { ...record, traces };
}

// ---------------- 元数据 ----------------

app.get('/api/meta', (_req, res) => {
  res.json({
    protocols: PROTOCOLS,
    difficulties: DIFFICULTIES,
    cubeSizes: CUBE_SIZE_INFO,
    defaultLimits: DEFAULT_LIMITS,
    stateEncoding: STATE_ENCODING,
    reasoningEfforts: REASONING_EFFORTS,
    maxActiveSessions: Number(process.env.MAX_ACTIVE_SESSIONS || 16),
  });
});

// ---------------- 模型配置 ----------------

/** 重新向供应商获取模型列表 */
app.post('/api/providers/refresh-models', wrap(async (req, res) => {
  const cfg = await refreshProvider(req.body?.config, req.body?.apiKey);
  res.json(cfg);
}));

/** 测试连接：用指定模型发送一次带测试工具的真实请求 */
app.post('/api/providers/test', wrap(async (req, res) => {
  const cfg = normalizeProvider(req.body?.config);
  const apiKey = validateApiKey(req.body?.apiKey);
  const model = String(req.body?.model ?? '').trim() || modelsOf(cfg)[0];
  if (!model) throw new DraftError('该供应商还没有可用模型');
  res.json(await testConnection(cfg, apiKey, model));
}));

// ---------------- 评测 ----------------

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

app.post('/api/runs', wrap(async (req, res) => {
  const body = (req.body ?? {}) as {
    entries?: RunEntry[]; providers?: { config: unknown; apiKey?: unknown }[]; difficulty?: string; scrambleLength?: number; cubeSize?: number; limits?: Partial<RunLimits> | null;
  };
  const { entries, difficulty, scrambleLength, cubeSize = 3 } = body;
  const limits = body.limits && typeof body.limits === 'object' && !Array.isArray(body.limits) ? body.limits : {};
  if (!CUBE_SIZE_INFO.some((c) => c.n === cubeSize)) throw new DraftError('不支持的魔方阶数');
  // 打乱步数：直接给出步数，或沿用预设 id
  const steps = scrambleLength ?? DIFFICULTIES.find((d) => d.id === difficulty)?.scrambleLength;
  if (!Number.isInteger(steps) || steps! < 1 || steps! > MAX_SCRAMBLE_LENGTH) throw new DraftError(`打乱步数应为 1～${MAX_SCRAMBLE_LENGTH}`);
  const diff = DIFFICULTIES.find((d) => d.scrambleLength === steps) ?? { id: 'custom', name: '自定义', scrambleLength: steps! };
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw new DraftError('请至少选择一个模型');
  if (list.length > 64) throw new DraftError('单局最多 64 个模型');
  const supplied: { config: unknown; apiKey?: unknown }[] = Array.isArray(req.body?.providers) ? req.body.providers : [];
  if (supplied.length > 64) throw new DraftError('单局最多 64 个供应商');
  const all = supplied.map((p) => {
    if (!p || typeof p !== 'object') throw new DraftError('供应商配置无效');
    return { config: normalizeProvider(p.config), apiKey: validateApiKey(p.apiKey) };
  });
  const byId = new Map(all.map((p) => [p.config.id, p]));
  const seen = new Set<string>();
  const contestants: ContestantEntry[] = [];
  for (const e of list) {
    const suppliedProvider = byId.get(String(e?.providerId));
    const config = suppliedProvider?.config;
    const model = String(e?.model ?? '').trim();
    if (!config || !model) throw new DraftError('部分模型不存在，请刷新后重试');
    if (!suppliedProvider?.apiKey && config.authMode !== 'none') throw new DraftError(`供应商「${config.name}」尚未设置 API Key`);
    if (!modelsOf(config).includes(model)) throw new DraftError(`供应商「${config.name}」没有模型 ${model}`);
    const reasoningEffort = REASONING_EFFORTS.some((r) => r.id === e.reasoningEffort) ? e.reasoningEffort : 'default';
    const maxOut = e.maxOutputTokens == null || String(e.maxOutputTokens) === '' ? null : Math.round(Number(e.maxOutputTokens));
    if (maxOut !== null && (!Number.isFinite(maxOut) || maxOut < 64 || maxOut > 200_000)) throw new DraftError('最大输出 Token 应为 64～200000');
    const key = `${config.id}\0${model}\0${reasoningEffort}\0${maxOut ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contestants.push({ config, apiKey: suppliedProvider?.apiKey, model, reasoningEffort, maxOutputTokens: maxOut });
  }
  const l: RunLimits = {
    maxDurationSec: clamp(limits.maxDurationSec, 10, 7200, DEFAULT_LIMITS.maxDurationSec),
    maxApiCalls: clamp(limits.maxApiCalls, 1, 1000, DEFAULT_LIMITS.maxApiCalls),
    maxMovesPerCall: clamp(limits.maxMovesPerCall, 1, 50, DEFAULT_LIMITS.maxMovesPerCall),
    maxNoToolCalls: clamp(limits.maxNoToolCalls, 1, 20, DEFAULT_LIMITS.maxNoToolCalls),
    maxNoProgressCalls: clamp(limits.maxNoProgressCalls, 1, 20, DEFAULT_LIMITS.maxNoProgressCalls),
    maxHistoryRounds: clamp(limits.maxHistoryRounds, 1, 10, DEFAULT_LIMITS.maxHistoryRounds),
    maxContextChars: clamp(limits.maxContextChars, 16_000, 500_000, DEFAULT_LIMITS.maxContextChars),
    concurrency: clamp(limits.concurrency, 1, 64, DEFAULT_LIMITS.concurrency),
    requestTimeoutSec: clamp(limits.requestTimeoutSec, 10, 600, DEFAULT_LIMITS.requestTimeoutSec),
  };
  const run = new Run(contestants, diff, l, cubeSize);
  runs.set(run.id, run);
  void run.start();
  res.json({ id: run.id });
}));

app.get('/api/runs', wrap(async (_req, res) => {
  const live = [...runs.values()].filter((r) => !r.done).map((r) => r.publicSummary());
  const saved = (await listRuns()).filter((s) => !live.some((l) => l.id === s.id));
  res.json([...live, ...saved]);
}));

app.get('/api/runs/:id', wrap(async (req, res) => {
  const live = runs.get(String(req.params.id));
  const record = live ? (live.done ? live.reportRecord() : live.publicRecord()) : await loadRun(String(req.params.id));
  if (!record) return res.status(404).json({ error: '记录不存在' });
  res.json(stripReasoning(record));
}));

/** 导出评测记录（不含任何密钥） */
app.get('/api/runs/:id/export', wrap(async (req, res) => {
  const live = runs.get(String(req.params.id));
  if (live && !live.done) return res.status(409).json({ error: '评测尚未结束，暂不可导出' });
  const record = live ? live.reportRecord() : await loadRun(String(req.params.id));
  if (!record) return res.status(404).json({ error: '记录不存在' });
  const safeRecord = stripReasoning(record);
  res.setHeader('Content-Disposition', `attachment; filename="cube-run-${record.id.slice(0, 8)}.json"`);
  res.json({ format: 'ai-cube-arena/run@1', stateEncoding: STATE_ENCODING, ...safeRecord });
}));

/** SSE：用单调序号订阅并回放，支持 Last-Event-ID 断线重连。 */
app.get('/api/runs/:id/stream', (req, res) => {
  const run = runs.get(String(req.params.id));
  if (!run) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const after = Number(req.get('Last-Event-ID') ?? 0);
  let closed = false;
  let unsubscribe = () => {};
  const send = (envelope: RunEventEnvelope) => {
    if (closed || envelope.seq <= after || res.destroyed || res.writableEnded) return;
    try {
      const event = envelope.event.type === 'call' && 'reasoning' in envelope.event.item
        ? { ...envelope, event: { ...envelope.event, item: (({ reasoning: _reasoning, ...item }) => item)(envelope.event.item) } }
        : envelope;
      res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      if (envelope.event.type === 'done') {
        closed = true;
        unsubscribe();
        res.end();
      }
    } catch {
      closed = true;
      unsubscribe();
      res.end();
    }
  };
  unsubscribe = run.subscribe(send);
  run.events.forEach(send);
  if (run.done && !closed) {
    closed = true;
    unsubscribe();
    res.end();
  }
  const ping = setInterval(() => {
    if (!closed && !res.destroyed && !res.writableEnded) res.write(': ping\n\n');
  }, 15_000);
  req.on('close', () => {
    closed = true;
    clearInterval(ping);
    unsubscribe();
  });
});

/** 全部模型：暂停 / 继续 / 停止 */
for (const action of ['pause', 'resume', 'stop'] as const) {
  app.post(`/api/runs/:id/${action}`, (req, res) => {
    const run = runs.get(String(req.params.id));
    if (!run || run.status === 'finished') return res.status(404).json({ error: '评测不存在或已结束' });
    if (action === 'pause') run.pauseAll();
    else if (action === 'resume') run.resumeAll();
    else run.stopAll();
    res.json({ ok: true });
  });
}

app.post('/api/runs/:id/contestants/:cid/:action', (req, res) => {
  const run = runs.get(String(req.params.id));
  const c = run?.contestant(String(req.params.cid));
  if (!c) return res.status(404).json({ error: '选手不存在或评测已结束' });
  if (TERMINAL_STATUSES.includes(c.status)) return res.status(409).json({ error: '该模型已结束' });
  const action = String(req.params.action);
  const ok = action === 'pause' ? c.pause() : action === 'resume' ? c.resume() : action === 'stop' ? c.stop() : null;
  if (ok === null) return res.status(400).json({ error: '未知操作' });
  res.json({ ok });
});

// ---------------- 静态资源与错误处理 ----------------

const dist = path.resolve(import.meta.dirname, '../dist');
if (process.env.NODE_ENV === 'production' && existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof DraftError) return res.status(400).json({ error: err.message });
  if ((err as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ error: '请求体过大' });
  // 不把内部错误细节（可能含敏感信息）返回给前端或写入日志
  console.error('请求处理失败：', (err as Error)?.name ?? 'Error');
  res.status(500).json({ error: '服务器内部错误' });
});

// 开发模式只认 API_PORT，避免与前端开发服务器共享的 PORT 变量冲突；生产模式兼容平台注入的 PORT
const port = Number(
  process.env.API_PORT || (process.env.NODE_ENV === 'production' ? process.env.PORT : undefined) || 8787,
);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  app.listen(port, () => {
    console.log(`魔方智竞服务已启动：http://localhost:${port}`);
  });
}
