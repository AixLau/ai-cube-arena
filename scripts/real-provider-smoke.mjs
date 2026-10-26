import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const apiKey = process.env.REAL_PROVIDER_API_KEY?.trim();
const requestedBase = process.env.REAL_PROVIDER_BASE_URL?.trim() || 'https://o10.top';
const requestedModel = process.env.REAL_PROVIDER_MODEL?.trim() || '';
const localOrigin = process.env.REAL_PROVIDER_LOCAL_ORIGIN?.replace(/\/$/, '') || 'http://127.0.0.1:8787';
const protocol = process.env.REAL_PROVIDER_PROTOCOL || 'openai-chat';
if (!apiKey) throw new Error('REAL_PROVIDER_API_KEY is required; it is read only from the process environment.');
if (protocol !== 'openai-chat') throw new Error('The smoke script currently supports REAL_PROVIDER_PROTOCOL=openai-chat.');

const port = Number(new URL(localOrigin).port || 8787);
const dataDir = mkdtempSync(join(tmpdir(), 'cube-arena-real-smoke-'));
const cwd = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(join(cwd, 'node_modules/.bin/tsx'), ['server/index.ts'], {
  cwd,
  env: { ...process.env, API_PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
child.stdout.on('data', (chunk) => { childOutput += String(chunk); });
child.stderr.on('data', (chunk) => { childOutput += String(chunk); });

async function stop() {
  if (!child.killed) child.kill('SIGTERM');
  await delay(100);
}
process.on('exit', () => { if (!child.killed) child.kill('SIGTERM'); });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${localOrigin}/api/meta`);
      if (response.ok) return;
    } catch { /* starting */ }
    await delay(250);
  }
  throw new Error(`local server did not start${childOutput ? `: ${childOutput.slice(-300)}` : ''}`);
}

async function json(path, options) {
  const response = await fetch(`${localOrigin}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${body.error || 'unknown error'}`);
  return body;
}

function config(baseUrl, models = []) {
  return {
    id: 'real-provider-smoke',
    name: new URL(baseUrl).host,
    protocol,
    baseUrl,
    authMode: 'bearer',
    maxConcurrentRequests: 2,
    models,
    manualModels: [],
    modelsFetchedAt: null,
    modelsError: null,
    keySource: 'browser',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function refresh(baseUrl) {
  return json('/api/providers/refresh-models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: config(baseUrl), apiKey }),
  });
}

async function streamRun(id, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${localOrigin}/api/runs/${id}/stream`, {
      signal: controller.signal,
      headers: options.lastEventId ? { 'Last-Event-ID': String(options.lastEventId) } : undefined,
    });
    if (!response.ok || !response.body) throw new Error(`SSE failed with HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((x) => x.startsWith('data: '));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        const event = payload.event ?? payload;
        events.push(event);
        const seq = typeof payload.seq === 'number' ? payload.seq : null;
        if (options.stopAfterFirst) {
          controller.abort();
          return { events, lastSeq: seq };
        }
        if (event.type === 'done') return events;
      }
    }
    return options.stopAfterFirst ? { events, lastSeq: null } : events;
  } finally {
    clearTimeout(timeout);
  }
}

try {
  await waitForServer();
  const candidates = [requestedBase, requestedBase.replace(/\/$/, '') + '/v1'].filter((value, index, all) => all.indexOf(value) === index);
  let usedBase = candidates[0];
  let refreshed;
  for (const candidate of candidates) {
    const result = await refresh(candidate);
    if (result.models?.length || requestedModel) { usedBase = candidate; refreshed = result; break; }
    refreshed = result;
  }
  const models = refreshed.models || [];
  const model = requestedModel || models[0];
  if (!model) throw new Error('No model returned. Set REAL_PROVIDER_MODEL to a model ID supported by the provider.');
  const cfg = config(usedBase, [model]);

  const test = await json('/api/providers/test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: cfg, apiKey, model }),
  });
  if (!test.ok) throw new Error(`tool test failed: ${test.message}`);

  const started = await json('/api/runs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entries: [{ providerId: cfg.id, model, reasoningEffort: 'default', maxOutputTokens: 512 }],
      providers: [{ config: cfg, apiKey }],
      cubeSize: 2,
      scrambleLength: 1,
      limits: { maxDurationSec: 90, maxApiCalls: 4, maxMovesPerCall: 4, maxNoToolCalls: 2, maxNoProgressCalls: 2, concurrency: 1, requestTimeoutSec: 30 },
    }),
  });
  let events;
  let reconnectReport = null;
  if (process.env.REAL_PROVIDER_DISCONNECT === '1') {
    const first = await streamRun(started.id, { stopAfterFirst: true });
    const second = await streamRun(started.id, { lastEventId: first.lastSeq || 0 });
    events = [...first.events, ...second];
    reconnectReport = { firstConnection: first.events.map((event) => event.type), secondConnection: second.map((event) => event.type), lastEventId: first.lastSeq };
  } else {
    events = await streamRun(started.id);
  }
  const record = await json(`/api/runs/${started.id}`);
  await json(`/api/runs/${started.id}/export`);
  const contestant = record.contestants[0];
  console.log(JSON.stringify({
    provider: new URL(usedBase).host,
    model,
    connectionTest: { ok: test.ok, toolSupport: test.toolSupport, usageReported: test.usageReported },
    run: { id: started.id, eventTypes: [...new Set(events.map((e) => e.type))], status: record.status, contestantStatus: contestant.status, apiCalls: contestant.stats.apiCalls, cost: contestant.stats.cost },
    disconnectRecovery: reconnectReport,
  }, null, 2));
} finally {
  await stop();
}
