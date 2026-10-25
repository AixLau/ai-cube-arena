import 'dotenv/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  CUBE_SIZE_INFO, DEFAULT_LIMITS, DIFFICULTIES, PROTOCOLS, REASONING_EFFORTS, TERMINAL_STATUSES, type ProviderDraft, type RunEntry, type RunLimits,
} from '../shared/types.ts';
import { STATE_ENCODING } from './arena/prompt.ts';
import { Run, runs, type ContestantEntry } from './arena/run.ts';
import { listRuns, loadRun } from './arena/store.ts';
import { encryptionAvailable } from './security/crypto.ts';
import {
  createConfig, deleteConfig, DraftError, duplicateConfig, getApiKey, getConfig, listConfigs, modelsOf, refreshModels, updateConfig,
} from './providers/store.ts';
import { testConnection } from './providers/test.ts';

const app = express();
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
app.use(express.json({ limit: '64kb' }));

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// ---------------- 元数据 ----------------

app.get('/api/meta', (_req, res) => {
  res.json({
    protocols: PROTOCOLS,
    difficulties: DIFFICULTIES,
    cubeSizes: CUBE_SIZE_INFO,
    defaultLimits: DEFAULT_LIMITS,
    encryptionAvailable: encryptionAvailable(),
    stateEncoding: STATE_ENCODING,
    reasoningEfforts: REASONING_EFFORTS,
    maxActiveSessions: Number(process.env.MAX_ACTIVE_SESSIONS || 16),
  });
});

// ---------------- 模型配置 ----------------

app.get('/api/providers', wrap(async (_req, res) => res.json(await listConfigs())));

app.post('/api/providers', wrap(async (req, res) => res.json(await createConfig(req.body as ProviderDraft))));

app.put('/api/providers/:id', wrap(async (req, res) => res.json(await updateConfig(String(req.params.id), req.body as ProviderDraft))));

app.post('/api/providers/:id/duplicate', wrap(async (req, res) => res.json(await duplicateConfig(String(req.params.id)))));

app.delete('/api/providers/:id', wrap(async (req, res) => {
  await deleteConfig(String(req.params.id));
  res.json({ ok: true });
}));

/** 重新向供应商获取模型列表 */
app.post('/api/providers/:id/refresh-models', wrap(async (req, res) => {
  const cfg = await refreshModels(String(req.params.id));
  if (!cfg) throw new DraftError('供应商不存在');
  res.json(cfg);
}));

/** 测试连接：用指定模型发送一次带测试工具的真实请求 */
app.post('/api/providers/:id/test', wrap(async (req, res) => {
  const cfg = await getConfig(String(req.params.id));
  if (!cfg) throw new DraftError('供应商不存在');
  const model = String(req.body?.model ?? '').trim() || modelsOf(cfg)[0];
  if (!model) throw new DraftError('该供应商还没有可用模型');
  res.json(await testConnection(cfg, await getApiKey(cfg.id), model));
}));

// ---------------- 评测 ----------------

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

app.post('/api/runs', wrap(async (req, res) => {
  const { entries, difficulty = 'easy', cubeSize = 3, limits = {} } = (req.body ?? {}) as {
    entries?: RunEntry[]; difficulty?: string; cubeSize?: number; limits?: Partial<RunLimits>;
  };
  if (!CUBE_SIZE_INFO.some((c) => c.n === cubeSize)) throw new DraftError('不支持的魔方阶数');
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw new DraftError('请至少选择一个模型');
  if (list.length > 64) throw new DraftError('单局最多 64 个模型');
  const all = await listConfigs();
  const seen = new Set<string>();
  const contestants: ContestantEntry[] = [];
  for (const e of list) {
    const config = all.find((c) => c.id === String(e?.providerId));
    const model = String(e?.model ?? '').trim();
    if (!config || !model) throw new DraftError('部分模型不存在，请刷新后重试');
    if (!modelsOf(config).includes(model)) throw new DraftError(`供应商「${config.name}」没有模型 ${model}`);
    const reasoningEffort = REASONING_EFFORTS.some((r) => r.id === e.reasoningEffort) ? e.reasoningEffort : 'default';
    const key = `${config.id}\0${model}\0${reasoningEffort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    contestants.push({ config, model, reasoningEffort });
  }
  const diff = DIFFICULTIES.find((d) => d.id === difficulty);
  if (!diff) throw new DraftError('未知难度');
  const l: RunLimits = {
    maxDurationSec: clamp(limits.maxDurationSec, 10, 7200, DEFAULT_LIMITS.maxDurationSec),
    maxApiCalls: clamp(limits.maxApiCalls, 1, 1000, DEFAULT_LIMITS.maxApiCalls),
    maxMovesPerCall: clamp(limits.maxMovesPerCall, 1, 50, DEFAULT_LIMITS.maxMovesPerCall),
    concurrency: clamp(limits.concurrency, 1, 64, DEFAULT_LIMITS.concurrency),
  };
  const run = new Run(contestants, diff, l, cubeSize);
  runs.set(run.id, run);
  void run.start();
  res.json({ id: run.id });
}));

app.get('/api/runs', wrap(async (_req, res) => {
  const live = [...runs.values()].filter((r) => r.status === 'running').map((r) => r.summary());
  const saved = (await listRuns()).filter((s) => !live.some((l) => l.id === s.id));
  res.json([...live, ...saved]);
}));

app.get('/api/runs/:id', wrap(async (req, res) => {
  const live = runs.get(String(req.params.id));
  const record = live ? live.record() : await loadRun(String(req.params.id));
  if (!record) return res.status(404).json({ error: '记录不存在' });
  res.json(record);
}));

/** 导出评测记录（不含任何密钥） */
app.get('/api/runs/:id/export', wrap(async (req, res) => {
  const live = runs.get(String(req.params.id));
  const record = live ? live.record() : await loadRun(String(req.params.id));
  if (!record) return res.status(404).json({ error: '记录不存在' });
  res.setHeader('Content-Disposition', `attachment; filename="cube-run-${record.id.slice(0, 8)}.json"`);
  res.json({ format: 'ai-cube-arena/run@1', stateEncoding: STATE_ENCODING, ...record });
}));

/** SSE：先回放已有事件，再推送实时事件 */
app.get('/api/runs/:id/stream', (req, res) => {
  const run = runs.get(String(req.params.id));
  if (!run) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  run.events.forEach(send);
  if (run.status === 'finished') return res.end();
  const unsubscribe = run.subscribe((e) => {
    send(e);
    if (e.type === 'done') res.end();
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

app.post('/api/runs/:id/stop', (req, res) => {
  const run = runs.get(String(req.params.id));
  if (!run) return res.status(404).json({ error: '评测不存在或已结束' });
  run.stopAll();
  res.json({ ok: true });
});

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
app.listen(port, () => {
  console.log(`魔方智竞服务已启动：http://localhost:${port}`);
});
