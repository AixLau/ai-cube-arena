import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'cube-arena-sse-'));
process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = 'true';
process.env.ALLOW_HTTP_PROVIDERS = 'true';

const { app } = await import('./index.ts');
const { Run, runs } = await import('./arena/run.ts');
const { DEFAULT_LIMITS } = await import('../shared/types.ts');

const get = (url: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
  const req = http.get(url, { headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
  });
  req.on('error', reject);
});

test('SSE：事件序号、回放和 Last-Event-ID 不丢失终态', async (t) => {
  const run = new Run([], { id: 'custom', name: '测试', scrambleLength: 1 }, DEFAULT_LIMITS);
  runs.set(run.id, run);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    runs.delete(run.id);
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/runs/${run.id}/stream`;
  const firstRequest = get(url);
  await run.start();
  const first = await firstRequest;
  assert.equal(first.status, 200);
  assert.match(first.headers['content-type'] ?? '', /text\/event-stream/);
  const firstIds = [...first.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(firstIds, [1, 2]);
  assert.doesNotMatch(first.body, /"scramble"|"initialState"/);
  assert.match(first.body, /"event":\{"type":"done"/);

  const replay = await get(url, { 'Last-Event-ID': '1' });
  const replayIds = [...replay.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(replayIds, [2]);
  assert.match(replay.body, /"type":"done"/);
});
