import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// 测试数据写入临时目录，必须在导入服务端模块之前设置
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'cube-arena-test-'));

const { resolveEndpoint } = await import('../shared/endpoint.ts');
const { assertAllowedUrl, isBlockedIp, safeLookup } = await import('./security/url.ts');
const { redact } = await import('./security/redact.ts');
const { normalizeProvider, refreshProvider } = await import('./providers/store.ts');
const { testConnection } = await import('./providers/test.ts');
const { MAX_ACTIVE_SESSIONS, Run, abortableDelay, positiveIntEnv, runs } = await import('./arena/run.ts');
const { DIFFICULTIES, DEFAULT_LIMITS } = await import('../shared/types.ts');
const { invertAlg, formatAlg, parseAlg, applyMoves, solvedState } = await import('../shared/cube.ts');
const { rotateCubeTool, systemPrompt, turnMessage } = await import('./arena/prompt.ts');

const withEnv = async (vars: Record<string, string | undefined>, fn: () => unknown) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ---------------- 模拟供应商 ----------------

interface MockState {
  solution: string[];
  calls: { path: string; body: any; headers: http.IncomingHttpHeaders; at: number }[];
  delayMs: number;
}
const mock: MockState = { solution: [], calls: [], delayMs: 0 };
let throttleLeft = 0;
let inFlight = 0;
let maxInFlight = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url ?? '';
    mock.calls.push({ path: url, body, headers: req.headers, at: Date.now() });
    if (url.startsWith('/throttle/') && throttleLeft > 0) {
      throttleLeft--;
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      return res.end(JSON.stringify({ error: { message: 'Concurrency limit exceeded for user' } }));
    }
    const limitedPath = url.startsWith('/limited/');
    if (limitedPath) maxInFlight = Math.max(maxInFlight, ++inFlight);
    if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
    if (limitedPath) inFlight--;
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.startsWith('/cancel-backoff/')) {
      return json(503, { error: { message: 'temporary upstream failure' } });
    }
    const moves = mock.solution;
    if (req.method === 'GET' && url.endsWith('/models')) {
      if (url.startsWith('/nolist/')) return json(404, { error: 'not found' });
      return json(200, { object: 'list', data: [{ id: 'mock-model' }, { id: 'mock-2' }] });
    }
    if (url.startsWith('/noeffort/') && body.reasoning_effort) {
      return json(400, { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } });
    }
    if (url.startsWith('/bad/')) return json(401, { error: { message: 'Invalid API key: sk-test-1234567890abcdef' } });
    if (url.startsWith('/redirect/')) {
      res.writeHead(302, { Location: 'http://169.254.169.254/' });
      return res.end();
    }
    if (url.startsWith('/notools/')) {
      if (body.tools) return json(400, { error: { message: 'tools is not supported by this model' } });
      return json(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    }
    // maxtok：模拟 OpenAI 推理模型拒绝 max_tokens
    if (url.startsWith('/maxtok/') && body.max_tokens !== undefined) {
      return json(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
    }
    if (url.startsWith('/nochoice/') && body.tool_choice === 'required') {
      return json(400, { error: { message: "tool_choice 'required' is not supported by this model" } });
    }
    if (url.startsWith('/stuck/') && url.endsWith('/chat/completions')) {
      return json(200, {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `stuck${mock.calls.length}`, type: 'function', function: { name: 'rotate_cube', arguments: JSON.stringify({ moves: ['U', 'U', 'U', 'U'] }) } }],
          },
        }],
      });
    }
    if (url.startsWith('/parallel/') && url.endsWith('/chat/completions')) {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const toolCalls = callNo === 1
        ? [
            { id: `parallel_a_${callNo}`, type: 'function', function: { name: 'rotate_cube', arguments: JSON.stringify({ moves: ['R'] }) } },
            { id: `parallel_b_${callNo}`, type: 'function', function: { name: 'rotate_cube', arguments: JSON.stringify({ moves: ['U'] }) } },
          ]
        : [{ id: `parallel_ok_${callNo}`, type: 'function', function: { name: 'rotate_cube', arguments: JSON.stringify({ moves }) } }];
      return json(200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: toolCalls } }] });
    }
    if (url.startsWith('/objectargs/') && url.endsWith('/chat/completions')) {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const args = { moves: callNo === 1 ? moves.slice(0, 1) : moves.slice(1) };
      return json(200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `object_args_${callNo}`, type: 'function', function: { name: 'rotate_cube', arguments: args } }] } }] });
    }
    if (url.startsWith('/malformed/') && url.endsWith('/chat/completions')) {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const args = callNo === 1 ? '{moves:[R]}' : JSON.stringify({ moves });
      return json(200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `malformed_${callNo}`, type: 'function', function: { name: 'rotate_cube', arguments: args } }] } }] });
    }
    if (url.startsWith('/unknown-tool/') && url.endsWith('/chat/completions')) {
      return json(200, { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'unknown_tool', type: 'function', function: { name: 'move_center_piece', arguments: JSON.stringify({ moves: ['R'] }) } }] } }] });
    }
    if (url.startsWith('/notoolloop/') && url.endsWith('/chat/completions')) {
      return json(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '我还在思考' } }] });
    }
    // planner：第一次只执行解法的第一步，把剩余步骤写进 plan；之后执行剩余步骤
    if (url.startsWith('/planner/') && body.tools?.[0]?.function?.name === 'rotate_cube') {
      const first = mock.calls.filter((c) => c.path === url).length === 1;
      const args = first ? { moves: mock.solution.slice(0, 1), plan: `接下来：${mock.solution.slice(1).join(' ')}` } : { moves: mock.solution.slice(1) };
      return json(200, {
        choices: [{
          finish_reason: 'tool_calls',
          message: { role: 'assistant', content: null, tool_calls: [{ id: `p${mock.calls.length}`, type: 'function', function: { name: 'rotate_cube', arguments: JSON.stringify(args) } }] },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
    }
    if (url.startsWith('/planner-2/') && body.tools?.[0]?.function?.name === 'rotate_cube') {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const responseMoves = callNo === 1 ? moves.slice(0, 1) : moves.slice(1);
      return json(200, {
        choices: [{
          finish_reason: 'tool_calls',
          message: { role: 'assistant', content: null, tool_calls: [{ id: `planner2_${callNo}`, type: 'function', function: { name: 'rotate_cube', arguments: JSON.stringify({ moves: responseMoves }) } }] },
        }],
      });
    }
    if (url.startsWith('/plan-clear/') && body.tools?.[0]?.function?.name === 'rotate_cube') {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const args = callNo === 1
        ? { moves: moves.slice(0, 1), plan: '旧计划' }
        : callNo === 2
          ? { moves: moves.slice(1, 2) }
          : { moves: moves.slice(2) };
      return json(200, {
        choices: [{
          finish_reason: 'tool_calls',
          message: { role: 'assistant', content: null, tool_calls: [{ id: `plan_clear_${callNo}`, type: 'function', function: { name: 'rotate_cube', arguments: JSON.stringify(args) } }] },
        }],
      });
    }
    if (url.startsWith('/planner-responses/') && url.endsWith('/responses')) {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const responseMoves = callNo === 1 ? moves.slice(0, 1) : moves.slice(1);
      return json(200, {
        status: 'completed',
        output: [
          { type: 'reasoning', id: `planner_rs_${callNo}`, summary: [{ type: 'summary_text', text: 'summary' }] },
          { type: 'function_call', id: `planner_fc_${callNo}`, call_id: `planner_call_${callNo}`, name: 'rotate_cube', arguments: JSON.stringify({ moves: responseMoves }) },
        ],
      });
    }
    if (url.startsWith('/planner-anthropic/') && url.endsWith('/messages')) {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const responseMoves = callNo === 1 ? moves.slice(0, 1) : moves.slice(1);
      return json(200, {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: `planner thinking ${callNo}`, signature: `sig_${callNo}` },
          { type: 'tool_use', id: `planner_tu_${callNo}`, name: 'rotate_cube', input: { moves: responseMoves } },
        ],
      });
    }
    if (url.startsWith('/planner-gemini/') && url.includes(':generateContent')) {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const responseMoves = callNo === 1 ? moves.slice(0, 1) : moves.slice(1);
      return json(200, {
        candidates: [{
          finishReason: 'STOP',
          content: { role: 'model', parts: [{ text: `planner thought ${callNo}`, thought: true }, { functionCall: { name: 'rotate_cube', args: { moves: responseMoves }, id: `planner_gem_${callNo}` }, thoughtSignature: `sig_${callNo}` }] },
        }],
      });
    }
    // chatty / nochoice：第一次请求只回复文字（chatty 的输出还被截断），思考写在 reasoning_content 与 <think> 中
    if ((url.startsWith('/chatty/') || url.startsWith('/nochoice/')) && mock.calls.filter((c) => c.path === url).length === 1) {
      return json(200, {
        choices: [{
          finish_reason: url.startsWith('/chatty/') ? 'length' : 'stop',
          message: { role: 'assistant', content: '<think>先看 U 面</think>我来分析一下', reasoning_content: '观察展开图' },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
    }
    if (url.endsWith('/chat/completions')) {
      const wantsTool = Array.isArray(body.tools);
      const isPing = body.tools?.[0]?.function?.name === 'ping';
      const noUsage = url.startsWith('/nousage/');
      const wrongFirst = url.startsWith('/wrong/') && mock.calls.filter((c) => c.path.startsWith('/wrong/') && c.path.endsWith('/chat/completions')).length === 1;
      // spin：先转 26 次 × 10 步 U（共 260 步，净效果为零），再给出解法
      const spinning = url.startsWith('/spin/') && mock.calls.filter((c) => c.path.startsWith('/spin/') && c.path.endsWith('/chat/completions')).length <= 26;
      return json(200, {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'thinking…',
            tool_calls: wantsTool
              ? [{ id: `c${mock.calls.length}`, type: 'function', function: { name: isPing ? 'ping' : 'rotate_cube', arguments: JSON.stringify(isPing ? { echo: 'cube' } : { moves: wrongFirst ? ['R', 'R', "X'"] : spinning ? Array(10).fill('U') : moves }) } }]
              : undefined,
          },
        }],
        ...(noUsage ? {} : { usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 }, cost: 0.001 } }),
      });
    }
    if (url.startsWith('/responses-legacy/') && url.endsWith('/responses')) {
      if (body.include || body.reasoning?.summary) {
        return json(400, { error: { message: 'Unknown field include or reasoning.summary' } });
      }
      return json(200, {
        status: 'completed',
        output: [{ type: 'function_call', id: 'legacy_fc', call_id: 'legacy_call', name: 'rotate_cube', arguments: JSON.stringify({ moves }) }],
        usage: { input_tokens: 80, output_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } },
      });
    }
    if (url.startsWith('/responses-memory/') && url.endsWith('/responses')) {
      const callNo = mock.calls.filter((c) => c.path === url).length;
      const responseMoves = callNo === 1 ? moves.slice(0, 1) : moves.slice(1);
      return json(200, {
        status: 'completed',
        output: [
          { type: 'reasoning', id: `rs_${callNo}`, summary: [{ type: 'summary_text', text: '推理摘要' }], content: [{ type: 'reasoning_text', text: '隐藏上下文' }], encrypted_content: 'encrypted-reasoning' },
          { type: 'function_call', id: `fc_${callNo}`, phase: 'commentary', call_id: `call_${callNo}`, name: 'rotate_cube', arguments: JSON.stringify({ moves: responseMoves }) },
        ],
        usage: { input_tokens: 80, output_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } },
      });
    }
    if (url.endsWith('/responses')) {
      return json(200, {
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: '推理摘要' }] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'rotate_cube', arguments: JSON.stringify({ moves }) },
        ],
        usage: { input_tokens: 80, output_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } },
      });
    }
    if (url.endsWith('/messages')) {
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      return json(200, {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '先还原底层', signature: 'sig' },
          { type: 'text', text: '开始复原' },
          { type: 'tool_use', id: 'tu_1', name: 'rotate_cube', input: { moves } },
        ],
        usage: { input_tokens: 70, cache_read_input_tokens: 10, output_tokens: 40 },
      });
    }
    if (url.includes(':generateContent')) {
      return json(200, {
        candidates: [{
          finishReason: 'STOP',
          content: { role: 'model', parts: [{ text: '思考摘要', thought: true }, { functionCall: { name: 'rotate_cube', args: { moves } }, thoughtSignature: 'sig' }] },
        }],
        usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 20, thoughtsTokenCount: 15 },
      });
    }
    json(404, { error: 'not found' });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.ALLOW_PRIVATE_PROVIDER_HOSTS = 'true';
process.env.ALLOW_HTTP_PROVIDERS = 'true';

// ---------------- 地址处理 ----------------

test('Base URL 拼接：不重复 /v1，支持完整端点与中转站子路径', () => {
  assert.equal(resolveEndpoint('openai-chat', 'https://relay.example.com/v1/', 'm'), 'https://relay.example.com/v1/chat/completions');
  assert.equal(resolveEndpoint('openai-chat', 'https://relay.example.com/openai/v1', 'm'), 'https://relay.example.com/openai/v1/chat/completions');
  assert.equal(resolveEndpoint('openai-chat', 'https://relay.example.com/v1/chat/completions', 'm'), 'https://relay.example.com/v1/chat/completions');
  assert.equal(resolveEndpoint('openai-chat', 'https://open.bigmodel.cn/api/paas/v4', 'm'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(resolveEndpoint('openai-chat', 'https://relay.example.com', 'm'), 'https://relay.example.com/chat/completions');
  assert.equal(resolveEndpoint('openai-responses', 'https://api.openai.com/v1', 'm'), 'https://api.openai.com/v1/responses');
  assert.equal(resolveEndpoint('anthropic', 'https://api.anthropic.com', 'm'), 'https://api.anthropic.com/v1/messages');
  assert.equal(resolveEndpoint('anthropic', 'https://relay.example.com/claude/v1', 'm'), 'https://relay.example.com/claude/v1/messages');
  assert.equal(resolveEndpoint('gemini', 'https://generativelanguage.googleapis.com/v1beta', 'models/gemini-x'), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
});

test('SSRF：拒绝内网、回环、元数据与明文地址', async () => {
  await withEnv({ ALLOW_PRIVATE_PROVIDER_HOSTS: undefined, ALLOW_HTTP_PROVIDERS: undefined }, () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '::1', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe']) {
      assert.ok(isBlockedIp(ip), ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isBlockedIp(ip), ip);
    for (const url of ['http://api.example.com/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://169.254.169.254/latest', 'https://localhost/v1', 'https://metadata.google.internal/', 'https://user:pw@api.example.com', 'https://intranet/v1', 'ftp://x.com']) {
      assert.throws(() => assertAllowedUrl(url), url);
    }
    assert.doesNotThrow(() => assertAllowedUrl('https://relay.example.com/openai/v1/chat/completions'));
  });
});

test('SSRF：连接时解析到内网地址的域名被拒绝（防 DNS 重绑定）', async () => {
  await withEnv({ ALLOW_PRIVATE_PROVIDER_HOSTS: undefined }, async () => {
    // localhost 由系统解析到 127.0.0.1 / ::1，模拟恶意域名解析到回环地址
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup('localhost', {}, (e) => resolve(e)));
    assert.equal(err?.code, 'EBLOCKEDADDR');
  });
});

test('脱敏：错误信息中不出现密钥', () => {
  const key = 'sk-test-1234567890abcdef';
  const out = redact(`invalid key ${key}; Authorization: Bearer abcdefghijklmnop; x-api-key=AIzaSyA1234567890123456789012`, [key]);
  assert.ok(!out.includes(key));
  assert.ok(!out.includes('abcdefghijklmnop'));
  assert.ok(!out.includes('AIzaSyA1234567890123456789012'));
  assert.ok(!redact('Your api key: ****5678 is invalid').includes('5678'));
});

const draft = (over: Record<string, unknown>) => ({
  name: 'mock', protocol: 'openai-chat', baseUrl: `${base}/v1`, authMode: 'bearer', apiKey: 'sk-test-1234567890abcdef',
  ...over,
}) as any;
// 测试用的短打乱：模拟供应商一次性给出全部解法，需在单次步数上限内
const D3 = { id: 'custom', name: '3', scrambleLength: 3 };
const D6 = { id: 'custom', name: '6', scrambleLength: 6 };
const E = (config: any, reasoningEffort: any = 'default', model = 'mock-model') => ({ config, apiKey: 'sk-test-1234567890abcdef', model, reasoningEffort });

async function makeProvider(over: Record<string, unknown> = {}) {
  const { apiKey, ...config } = draft(over);
  return refreshProvider({ ...config, id: randomUUID() }, apiKey);
}

test('供应商请求无状态：密钥不回传、不落盘、不复用之前请求的密钥', async () => {
  const input = { ...draft({}), id: randomUUID() };
  const cfg = await refreshProvider(input, input.apiKey);
  assert.equal(cfg.keySource, 'browser');
  assert.ok(!JSON.stringify(cfg).includes(input.apiKey));
  assert.ok(!('apiKey' in cfg));
  const withoutKey = await refreshProvider(input, undefined);
  assert.equal(withoutKey.keySource, 'none');
  assert.match(withoutKey.modelsError ?? '', /API Key/);
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, 'providers.json')), false);
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, 'credentials.json')), false);
});

test('供应商校验保留最多 1000 个自动模型，拒绝无效地址、并发和密钥', async () => {
  const models = Array.from({ length: 1000 }, (_, i) => `model-${i}`);
  const input = { ...draft({}), id: randomUUID(), models };
  assert.deepEqual(normalizeProvider(input).models, models);
  assert.throws(() => normalizeProvider({ ...input, maxConcurrentRequests: 0 }), /并发/);
  assert.throws(() => normalizeProvider({ ...input, baseUrl: 'ftp://example.com' }), /HTTPS|协议/);
  await assert.rejects(refreshProvider(input, 'invalid key'), /API Key/);
});

test('HTTP 供应商接口：移除旧存储接口，环境变量不预置，每次请求必须携带配置和密钥', async (t) => {
  const { app } = await import('./index.ts');
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  const post = (url: string, body: unknown) => fetch(`${origin}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  await withEnv({ DEEPSEEK_API_KEY: 'server-secret-must-not-be-used' }, async () => {
    assert.equal((await fetch(`${origin}/api/providers`)).status, 404);
    assert.equal((await post('/api/providers', draft({}))).status, 404);
    assert.equal((await post('/api/providers/legacy/duplicate', {})).status, 404);
    const meta = await (await fetch(`${origin}/api/meta`)).json() as Record<string, unknown>;
    assert.equal(meta.maxActiveSessions, MAX_ACTIVE_SESSIONS);
    assert.ok(!('encryptionAvailable' in meta));
    assert.ok(!JSON.stringify(meta).includes('server-secret'));

    const config = { ...draft({}), id: 'env-deepseek' };
    const refreshed = await post('/api/providers/refresh-models', { config, apiKey: config.apiKey });
    assert.equal(refreshed.status, 200);
    const result = await refreshed.json() as Record<string, unknown>;
    assert.ok(!JSON.stringify(result).includes(config.apiKey));
    assert.equal(refreshed.headers.get('cache-control'), 'no-store');
    const largeConfig = {
      ...config, models: Array.from({ length: 1000 }, (_, i) => `model-${i}-${'x'.repeat(120)}`),
    };
    assert.equal((await post('/api/providers/refresh-models', { config: largeConfig, apiKey: config.apiKey })).status, 200);

    const unkeyed = await post('/api/providers/refresh-models', { config });
    const withoutKey = await unkeyed.json() as { keySource: string; modelsError: string };
    assert.equal(withoutKey.keySource, 'none');
    assert.match(withoutKey.modelsError, /API Key/);

    const connected = await post('/api/providers/test', { config, apiKey: config.apiKey, model: 'mock-model' });
    assert.equal((await connected.json() as { ok: boolean }).ok, true);
    const disconnected = await post('/api/providers/test', { config, model: 'mock-model' });
    assert.equal((await disconnected.json() as { ok: boolean }).ok, false);

    const runBody = { entries: [{ providerId: config.id, model: 'mock-model' }], scrambleLength: 3 };
    assert.equal((await post('/api/runs', runBody)).status, 400);
    assert.equal((await post('/api/runs', { ...runBody, providers: [{ config: { ...config, models: ['mock-model'] } }] })).status, 400);
    assert.equal((await post('/api/runs', { ...runBody, providers: [null] })).status, 400);

    mock.delayMs = 50;
    try {
      const started = await post('/api/runs', {
        ...runBody, providers: [{ config: { ...config, models: ['mock-model'] }, apiKey: config.apiKey }],
      });
      assert.equal(started.status, 200);
      const { id } = await started.json() as { id: string };
      const ownerCookie = started.headers.get('set-cookie')!.split(';')[0];
      const getOwned = (url: string) => fetch(url, { headers: { Cookie: ownerCookie } });
      mock.solution = formatAlg(invertAlg(runs.get(id)!.scramble)).split(' ');
      const events = await (await getOwned(`${origin}/api/runs/${id}/stream`)).text();
      assert.ok(!events.includes(config.apiKey));
      assert.ok(!events.includes('thinking…'), 'SSE 默认不公开原始 reasoning');
      const publicRecord = await (await getOwned(`${origin}/api/runs/${id}`)).json() as Record<string, unknown>;
      assert.equal('scramble' in publicRecord, false);
      assert.equal('initialState' in publicRecord, false);
      assert.equal((await fetch(`${origin}/api/runs/${id}/report`)).status, 404, '没有 owner cookie 不能读取私有报告');
      const privateReport = await (await getOwned(`${origin}/api/runs/${id}/report`)).json() as Record<string, unknown>;
      assert.equal(typeof privateReport.scramble, 'string');
      const exported = await (await getOwned(`${origin}/api/runs/${id}/export`)).json() as {
        contestants: { status: string }[];
      };
      assert.equal(exported.contestants[0].status, 'solved');
      assert.ok(!JSON.stringify(exported).includes(config.apiKey));
      assert.ok(!JSON.stringify(exported).includes('baseUrl'));
      assert.ok(!JSON.stringify(exported).includes('thinking…'), '导出默认不包含原始 reasoning');
    } finally {
      mock.delayMs = 0;
    }
  });
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, 'providers.json')), false);
  assert.equal(existsSync(path.join(process.env.DATA_DIR!, 'credentials.json')), false);
});

test('测试连接：成功、工具支持、401 脱敏、重定向拒绝、不支持工具', async () => {
  const mk = (p: string) => ({ ...draft({ baseUrl: `${base}${p}` }), id: 'x', keySource: 'browser', createdAt: '', updatedAt: '' });
  const ok = await testConnection(mk('/v1'), 'sk-test-1234567890abcdef', 'mock-model');
  assert.equal(ok.ok, true);
  assert.equal(ok.toolSupport, 'supported');
  const bad = await testConnection(mk('/bad/v1'), 'sk-test-1234567890abcdef', 'mock-model');
  assert.equal(bad.ok, false);
  assert.equal(bad.httpStatus, 401);
  assert.ok(!JSON.stringify(bad).includes('sk-test-1234567890abcdef'), '错误信息不能包含密钥');
  const redirect = await testConnection(mk('/redirect/v1'), 'k-123456', 'mock-model');
  assert.match(redirect.message, /重定向/);
  const noTools = await testConnection(mk('/notools/v1'), 'k-123456', 'mock-model');
  assert.equal(noTools.ok, true);
  assert.equal(noTools.toolSupport, 'rejected');
});

test('多模型同题评测：同一初始状态、独立状态、真正并发、失败隔离、Token 口径', async () => {
  const configs = [
    await makeProvider({ name: 'chat' }),
    await makeProvider({ name: 'responses', protocol: 'openai-responses' }),
    await makeProvider({ name: 'anthropic', protocol: 'anthropic', baseUrl: base, authMode: 'x-api-key' }),
    await makeProvider({ name: 'gemini', protocol: 'gemini', baseUrl: `${base}/v1beta`, authMode: 'x-goog-api-key' }),
    await makeProvider({ name: 'bad', baseUrl: `${base}/bad/v1` }),
    await makeProvider({ name: 'nousage', baseUrl: `${base}/nousage/v1` }),
    await makeProvider({ name: 'wrong', baseUrl: `${base}/wrong/v1` }),
  ];
  mock.calls = [];
  mock.delayMs = 300;
  const run = new Run(configs.map((c) => E(c)), D6, { ...DEFAULT_LIMITS, concurrency: 8 });
  const scramble = formatAlg(run.scramble);
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  const started = Date.now();
  await run.start();
  const elapsed = Date.now() - started;
  const byName = Object.fromEntries(run.contestants.map((c) => [c.info.name, c.snapshot()]));

  // 并发：7 个模型各需 ≥1 次 300ms 请求，串行至少 2.1 秒
  assert.ok(elapsed < 1500, `应并发运行，实际耗时 ${elapsed}ms`);
  for (const n of ['chat', 'responses', 'anthropic', 'gemini', 'nousage', 'wrong']) assert.equal(byName[n].status, 'solved', n);
  assert.equal(byName.bad.status, 'error');
  assert.ok(!byName.bad.failReason!.includes('sk-test-1234567890abcdef'));

  // 独立状态：wrong 先执行了一次被拒绝的调用（含非法记号，整次不执行），之后仍从同一初始状态复原
  assert.equal(byName.wrong.stats.invalidToolCalls, 1);
  assert.equal(byName.wrong.stats.moves, mock.solution.length);
  assert.equal(byName.chat.stats.moves, mock.solution.length);

  // Token：推理 Token 不重复累加；未返回用量显示为未知；费用只取供应商返回的计费
  assert.equal(byName.chat.stats.outputTokens, 50);
  assert.equal(byName.chat.stats.reasoningTokens, 20);
  assert.equal(byName.chat.stats.cost, 0.001);
  assert.equal(byName.responses.stats.cost, null);
  assert.equal(byName.gemini.stats.outputTokens, 35);
  assert.equal(byName.gemini.stats.reasoningTokens, 15);
  assert.equal(byName.anthropic.stats.inputTokens, 80);
  assert.equal(byName.anthropic.stats.reasoningTokens, null);
  assert.equal(byName.nousage.stats.inputTokens, null);
  assert.equal(byName.nousage.stats.cost, null);

  const publicSummary = run.publicSummary();
  assert.equal('scramble' in publicSummary, false);
  assert.equal('initialState' in publicSummary, false);
  assert.deepEqual(run.events.map((e) => e.seq), run.events.map((_, i) => i + 1), '事件序号必须单调递增');
  assert.equal(run.events[0].event.type, 'init');
  const publicReasoning = Object.values(run.publicRecord().traces).flatMap((items) => items.filter((item: any) => item.type === 'call'));
  assert.ok(publicReasoning.every((item: any) => !('reasoning' in item)), '公开运行记录不应包含原始 reasoning');

  // 思考内容：各协议的思考字段都提取到调用记录，正文不混入思考
  const firstCall = (name: string) => run.contestants.find((c) => c.info.name === name)!.trace.find((t) => t.type === 'call') as any;
  assert.equal(firstCall('chat').reasoning, 'thinking…');
  assert.equal(firstCall('responses').reasoning, '推理摘要');
  assert.equal(firstCall('anthropic').reasoning, '先还原底层');
  assert.equal(firstCall('anthropic').text, '开始复原');
  assert.equal(firstCall('gemini').reasoning, '思考摘要');
  assert.equal(firstCall('gemini').text, '');

  // 模型拿不到打乱公式；所有模型收到相同的系统提示与初始状态
  const first = mock.calls.filter((c) => c.path.endsWith('/chat/completions') && c.body.tools?.[0]?.function?.name === 'rotate_cube');
  const sys = new Set(first.map((c) => c.body.messages[0].content));
  assert.equal(sys.size, 1);
  const geminiRequest = mock.calls.find((c) => c.path.includes(':generateContent'));
  assert.ok(geminiRequest);
  const geminiParameters = geminiRequest!.body.tools[0].functionDeclarations[0].parameters;
  assert.equal(geminiParameters.additionalProperties, undefined);
  assert.deepEqual(geminiParameters.properties.moves.items.enum.length, 18);
  assert.equal(geminiParameters.properties.moves.minItems, 1);
  assert.equal(geminiParameters.properties.moves.maxItems, DEFAULT_LIMITS.maxMovesPerCall);
  for (const c of mock.calls) assert.ok(!JSON.stringify(c.body).includes(scramble), '请求中不应出现打乱公式');
  // 请求中不出现其它选手或服务端的密钥以外的内容：Authorization 正确
  assert.equal(first[0].headers.authorization, 'Bearer sk-test-1234567890abcdef');
  // 协议适配器保留必要的上一轮工具关联；长历史由专门的回放测试覆盖
  const wrongCalls = mock.calls.filter((c) => c.path.startsWith('/wrong/') && c.path.endsWith('/chat/completions'));
  assert.ok(wrongCalls.length >= 2);
  assert.ok(wrongCalls.every((c) => {
    const history = c.body.messages.filter((m: any) => m.role === 'assistant' || m.role === 'tool');
    return history.length <= 2 && c.body.messages.length <= 5;
  }));
  const rejectedResult = JSON.parse(wrongCalls[1].body.messages.find((m: any) => m.role === 'tool').content);
  assert.deepEqual(rejectedResult.error, { code: 'INVALID_MOVE', message: "非法记号：X'，整次调用未执行", retryable: true });
  assert.equal(rejectedResult.applied_moves.length, 0);
  assert.equal(rejectedResult.solved, false);
  assert.ok(rejectedResult.state.state_hash);
  assert.match(wrongCalls[1].body.messages.at(-1).content, /最近的调用[\s\S]*#1 未执行：非法记号/);
  // 事件中不出现密钥
  assert.ok(!JSON.stringify(run.events).includes('sk-test-1234567890abcdef'));
  const persisted = readFileSync(path.join(process.env.DATA_DIR!, 'runs', `${run.id}.json`), 'utf8');
  assert.ok(!persisted.includes('sk-test-1234567890abcdef'));
  assert.ok(!persisted.includes('baseUrl'));
  for (const c of run.contestants) {
    const transient = c as unknown as { config?: unknown; apiKey?: unknown };
    assert.equal(transient.config, undefined, '评测结束后不保留供应商配置');
    assert.equal(transient.apiKey, undefined, '评测结束后不保留 API Key');
  }
  mock.delayMs = 0;
});

test('单局并发限制下，单个模型可停止且不影响其它', async () => {
  const configs = [await makeProvider({ name: 'a' }), await makeProvider({ name: 'b' })];
  mock.delayMs = 200;
  const run = new Run(configs.map((c) => E(c)), D3, { ...DEFAULT_LIMITS, concurrency: 1 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  const done = run.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(run.contestants[1].status, 'queued');
  run.contestants[0].stop();
  await done;
  assert.equal(run.contestants[0].status, 'stopped');
  assert.equal(run.contestants[1].status, 'solved');
  mock.delayMs = 0;
});

test('限流：429 按 Retry-After 重试且不计入调用预算；同一密钥的并发请求受上限约束', async () => {
  // 3 个配置共用同一密钥与地址，上限 1 个并发请求
  const shared = [1, 2, 3].map((i) => draft({ name: `limited-${i}`, baseUrl: `${base}/limited/v1`, maxConcurrentRequests: 1 }));
  const configs = [];
  for (const d of shared) configs.push(await makeProvider(d));
  const throttled = await makeProvider({ name: 'throttled', baseUrl: `${base}/throttle/v1` });
  mock.delayMs = 150;
  maxInFlight = 0;
  throttleLeft = 2;
  const run = new Run([...configs, throttled].map((c) => E(c)), D3, { ...DEFAULT_LIMITS, concurrency: 8 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  for (const c of run.contestants) assert.equal(c.status, 'solved', c.info.name);
  assert.equal(maxInFlight, 1, '同一密钥同时只能有 1 个请求');
  const t = run.contestants.find((c) => c.info.name === 'throttled')!.snapshot().stats;
  assert.equal(t.throttledCalls, 2);
  assert.equal(t.apiCalls, 1, '被限流的请求不计入 API 调用');
  assert.equal(t.usageMissingCalls, 0, '429 未产生用量，不算用量未知');
  mock.delayMs = 0;
});

test('不限制总旋转次数：超过 200 步后仍可继续并复原', async () => {
  const cfg = await makeProvider({ name: 'spin', baseUrl: `${base}/spin/v1` });
  const run = new Run([E(cfg)], D6, { ...DEFAULT_LIMITS, maxApiCalls: 40, concurrency: 1 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  const c = run.contestants[0].snapshot();
  assert.equal(c.status, 'solved');
  assert.equal(c.stats.moves, 260 + mock.solution.length);
  const spinCalls = mock.calls.filter((x) => x.path.startsWith('/spin/') && x.path.endsWith('/chat/completions'));
  const latestSpin = spinCalls.at(-1)!;
  const spinHistory = latestSpin.body.messages.filter((m: any) => m.role === 'assistant' || m.role === 'tool');
  assert.ok(spinHistory.length > 2, '长评测应保留完整 assistant/tool 历史');
  assert.ok(spinHistory.length <= DEFAULT_LIMITS.maxHistoryRounds * 2, '长评测应在上下文预算内压缩旧回合');
  assert.ok(run.contestants[0].trace.some((item) => item.type === 'log' && /压缩/.test(item.text)));
});

test('供应商：保存后自动获取模型列表；不支持列表时可手动补充', async () => {
  const cfg = await makeProvider({ name: undefined });
  assert.deepEqual(cfg.models, ['mock-2', 'mock-model']);
  assert.equal(cfg.modelsError, null);
  assert.equal(cfg.name, new URL(base).host, '名称默认使用域名');
  const nolist = await makeProvider({ baseUrl: `${base}/nolist/v1`, manualModels: ['my-model'] });
  assert.deepEqual(nolist.models, []);
  assert.match(nolist.modelsError ?? '', /手动/);
  assert.deepEqual(nolist.manualModels, ['my-model']);
});

test('推理强度：按协议发送参数；模型拒绝时去掉参数重试并标记', async () => {
  const ok = await makeProvider({ name: 'effort' });
  const rejecting = await makeProvider({ name: 'noeffort', baseUrl: `${base}/noeffort/v1` });
  mock.calls = [];
  const run = new Run([E(ok, 'high'), E(rejecting, 'low'), E(ok, 'default', 'mock-2')], D3, { ...DEFAULT_LIMITS, concurrency: 4 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  for (const c of run.contestants) assert.equal(c.status, 'solved');
  const sent = (model: string, prefix: string) => mock.calls.filter((c) => c.path.startsWith(prefix) && c.body.model === model && c.body.tools);
  assert.equal(sent('mock-model', '/v1/')[0].body.reasoning_effort, 'high');
  assert.equal(sent('mock-2', '/v1/')[0].body.reasoning_effort, undefined, '默认推理强度不发送参数');
  const r = run.contestants[1].snapshot();
  assert.equal(r.stats.effortIgnored, true);
  assert.equal(r.stats.apiCalls, 1, '被拒绝的参数请求不计入调用预算');
});

test('多阶魔方：4 阶与 2 阶同题评测，提示词说明阶数，初始状态为 6×N×N', async () => {
  const cfg = await makeProvider({ name: 'nxn' });
  for (const n of [2, 4]) {
    mock.calls = [];
    const run = new Run([E(cfg)], D6, { ...DEFAULT_LIMITS, concurrency: 1 }, n);
    mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
    await run.start();
    assert.equal(run.contestants[0].status, 'solved', `${n} 阶`);
    assert.equal(run.summary().cubeSize, n);
    assert.equal(run.summary().initialState.length, 6 * n * n);
    assert.match(mock.calls[0].body.messages[0].content, new RegExp(`${n}×${n}×${n}`));
  }
});

test('参数兼容：max_tokens 被拒绝时改用 max_completion_tokens，不误判为推理强度不受支持', async () => {
  const cfg = await makeProvider({ name: 'maxtok', baseUrl: `${base}/maxtok/v1` });
  mock.calls = [];
  const run = new Run([{ ...E(cfg, 'high'), maxOutputTokens: 512 }], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  const c = run.contestants[0].snapshot();
  assert.equal(c.status, 'solved');
  assert.ok(!c.stats.effortIgnored, '推理强度不应被去掉');
  assert.equal(c.stats.apiCalls, 1, '字段改写后的重试属于同一次调用');
  const sent = mock.calls.filter((x) => x.path.startsWith('/maxtok/') && x.body.tools);
  assert.equal(sent[0].body.max_tokens, 512);
  const last = sent.at(-1)!.body;
  assert.equal(last.max_tokens, undefined);
  assert.equal(last.max_completion_tokens, 512);
  assert.equal(last.reasoning_effort, 'high');
});

test('未调用工具：下一次强制 tool_choice=required；输出截断时提示模型，思考内容与正文分开记录', async () => {
  const cfg = await makeProvider({ name: 'chatty', baseUrl: `${base}/chatty/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  const contestant = run.contestants[0];
  assert.equal(contestant.status, 'solved');
  const sent = mock.calls.filter((x) => x.path.startsWith('/chatty/'));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.tool_choice, 'auto');
  assert.equal(sent[1].body.tool_choice, 'required');
  assert.match(sent[1].body.messages.at(-1).content, /截断/);
  const first = contestant.trace.find((t) => t.type === 'call') as any;
  assert.equal(first.text, '我来分析一下');
  assert.equal(first.reasoning, '观察展开图\n\n先看 U 面');
  assert.equal(first.truncated, true);
  assert.ok(contestant.trace.some((t) => t.type === 'log' && /截断/.test(t.text)));
});

test('强制工具调用被拒绝：回退为 auto 继续，不误判为推理强度不受支持', async () => {
  const cfg = await makeProvider({ name: 'nochoice', baseUrl: `${base}/nochoice/v1` });
  mock.calls = [];
  const run = new Run([E(cfg, 'low')], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  const c = run.contestants[0].snapshot();
  assert.equal(c.status, 'solved');
  assert.ok(!c.stats.effortIgnored);
  assert.equal(c.stats.apiCalls, 2, '被拒绝的 required 请求不计入调用');
  const sent = mock.calls.filter((x) => x.path.startsWith('/nochoice/'));
  assert.deepEqual(sent.map((x) => x.body.tool_choice), ['auto', 'required', 'auto']);
  assert.equal(sent[2].body.reasoning_effort, 'low');
  assert.ok(run.contestants[0].trace.some((t) => t.type === 'log' && /强制工具调用/.test(t.text)));
});

test('每轮记忆：模型记下的计划与最近调用的效果带到下一轮，并保留原始协议历史', async () => {
  const cfg = await makeProvider({ name: 'planner', baseUrl: `${base}/planner/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  const contestant = run.contestants[0];
  assert.equal(contestant.status, 'solved');
  const sent = mock.calls.filter((x) => x.path.startsWith('/planner/'));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.tools[0].function.parameters.properties.plan.type, 'string');
  assert.match(sent[0].body.messages[1].content, /当前没有模型备注/);
  const second = sent[1].body.messages;
  assert.equal(second.length, 5, '第二轮包含初始状态、assistant/tool 原始块和最新状态');
  assert.equal(second.filter((m: any) => m.role === 'assistant' || m.role === 'tool').length, 2);
  assert.ok(second.at(-1).content.includes(`最近的调用（从旧到新）：\n#1 ${mock.solution[0]}\n`));
  assert.ok(!/已归位|变好|变差|撤销/.test(second.at(-1).content), '只给状态与事实，不评价进展');
  assert.ok(second.at(-1).content.includes(`模型在第 1 次调用时记下的备注（仅供参考）：接下来：${mock.solution.slice(1).join(' ')}`));
  const firstCall = contestant.trace.find((t) => t.type === 'call') as any;
  assert.equal(firstCall.plan, `接下来：${mock.solution.slice(1).join(' ')}`);
});

test('工具备注：运行时截断并在后续未携带新备注时清除旧 plan', async () => {
  const cfg = await makeProvider({ name: 'plan-clear', baseUrl: `${base}/plan-clear/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(run.contestants[0].status, 'solved');
  const calls = mock.calls.filter((c) => c.path.startsWith('/plan-clear/'));
  assert.equal(calls.length, 3);
  assert.match(calls[1].body.messages.at(-1).content, /旧计划/);
  assert.doesNotMatch(calls[2].body.messages.at(-1).content, /模型在第 \d+ 次调用时记下的备注.*旧计划/);
});

test('Responses API：保留一轮工具上下文、原始元数据并请求简洁推理摘要', async () => {
  const cfg = await makeProvider({ name: 'responses-memory', protocol: 'openai-responses', baseUrl: `${base}/responses-memory/v1` });
  mock.calls = [];
  const run = new Run([E(cfg, 'high')], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(run.contestants[0].status, 'solved');
  const sent = mock.calls.filter((x) => x.path.startsWith('/responses-memory/') && x.path.endsWith('/responses'));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(sent[0].body.reasoning, { effort: 'high', summary: 'concise' });
  const input = sent[1].body.input as any[];
  assert.ok(input.some((x) => x.type === 'reasoning' && x.id === 'rs_1' && x.encrypted_content === 'encrypted-reasoning'));
  assert.ok(input.some((x) => x.type === 'reasoning' && x.content?.[0]?.text === '隐藏上下文'));
  assert.ok(input.some((x) => x.type === 'function_call' && x.id === 'fc_1' && x.phase === 'commentary'));
  const output = input.find((x) => x.type === 'function_call_output');
  assert.ok(output);
  assert.match(output.output, /moves_used/);
  assert.match(output.output, /correct_stickers/);
  assert.match(output.output, /state/);
  assert.equal(sent[0].body.parallel_tool_calls, false);
});

test('四种协议：二轮以上回放保留工具关联、provider metadata 和最新状态', async () => {
  const configs = [
    await makeProvider({ name: 'planner-chat-2', baseUrl: `${base}/planner-2/v1` }),
    await makeProvider({ name: 'planner-responses', protocol: 'openai-responses', baseUrl: `${base}/planner-responses/v1` }),
    await makeProvider({ name: 'planner-anthropic', protocol: 'anthropic', baseUrl: `${base}/planner-anthropic`, authMode: 'x-api-key' }),
    await makeProvider({ name: 'planner-gemini', protocol: 'gemini', baseUrl: `${base}/planner-gemini/v1beta`, authMode: 'x-goog-api-key' }),
  ];
  mock.calls = [];
  const run = new Run(configs.map((c) => E(c)), D3, { ...DEFAULT_LIMITS, concurrency: 4 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  for (const c of run.contestants) assert.equal(c.status, 'solved', c.info.name);

  const chat = mock.calls.filter((c) => c.path.startsWith('/planner-2/') && c.path.endsWith('/chat/completions'));
  assert.equal(chat.length, 2);
  assert.ok(chat[1].body.messages.some((m: any) => m.role === 'tool'));
  assert.ok(/state_hash/.test(chat[1].body.messages.at(-1).content));

  const responses = mock.calls.filter((c) => c.path.startsWith('/planner-responses/') && c.path.endsWith('/responses'));
  assert.equal(responses.length, 2);
  assert.ok((responses[1].body.input as any[]).some((item) => item.type === 'function_call_output'));
  assert.ok((responses[1].body.input as any[]).some((item) => item.role === 'user' && /state_hash/.test(item.content)));

  const anthropic = mock.calls.filter((c) => c.path.startsWith('/planner-anthropic/') && c.path.endsWith('/messages'));
  assert.equal(anthropic.length, 2);
  assert.ok(anthropic[1].body.messages.some((m: any) => m.role === 'assistant' && m.content.some((b: any) => b.type === 'tool_use')));
  assert.ok(anthropic[1].body.messages.some((m: any) => m.role === 'user' && m.content.some((b: any) => b.type === 'tool_result')));

  const gemini = mock.calls.filter((c) => c.path.startsWith('/planner-gemini/') && c.path.includes(':generateContent'));
  assert.equal(gemini.length, 2);
  assert.ok(gemini[1].body.contents.some((content: any) => content.role === 'model' && content.parts.some((p: any) => p.functionCall)));
  assert.ok(gemini[1].body.contents.some((content: any) => content.role === 'user' && content.parts.some((p: any) => p.functionResponse)));
  const geminiResponse = gemini[1].body.contents.flatMap((content: any) => content.parts).find((part: any) => part.functionResponse);
  assert.equal(typeof geminiResponse.functionResponse.response, 'object');
  assert.equal(typeof geminiResponse.functionResponse.response.ok, 'boolean');
});

test('Responses API：旧中转拒绝可选推理字段时回退到基础请求', async () => {
  const cfg = await makeProvider({ name: 'responses-legacy', protocol: 'openai-responses', baseUrl: `${base}/responses-legacy/v1` });
  mock.calls = [];
  const run = new Run([E(cfg, 'high')], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(run.contestants[0].status, 'solved');
  const sent = mock.calls.filter((x) => x.path.startsWith('/responses-legacy/') && x.path.endsWith('/responses'));
  assert.equal(sent.length, 3, '分别回退 include 与 summary 后再成功');
  assert.ok(sent[0].body.include);
  assert.equal(sent[1].body.include, undefined);
  assert.equal(sent[1].body.reasoning?.summary, 'concise');
  assert.equal(sent[2].body.include, undefined);
  assert.deepEqual(sent[2].body.reasoning, { effort: 'high' });
  assert.equal(run.contestants[0].snapshot().stats.apiCalls, 1, '兼容性重试不应增加评测调用次数');
});

test('Responses 默认模式不强制发送可选 reasoning 参数', async () => {
  const cfg = await makeProvider({ name: 'responses-default', protocol: 'openai-responses', baseUrl: `${base}/responses-default/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(run.contestants[0].status, 'solved');
  const sent = mock.calls.filter((x) => x.path.startsWith('/responses-default/') && x.path.endsWith('/responses'));
  assert.equal(sent[0].body.reasoning, undefined);
  assert.equal(sent[0].body.include, undefined);
});

test('运行预算：达到 API 调用上限和连续无工具上限时失败', async () => {
  const cfg = await makeProvider({ name: 'budget', baseUrl: `${base}/spin/v1` });
  const run = new Run([E(cfg)], D6, { ...DEFAULT_LIMITS, maxApiCalls: 1 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(run.contestants[0].status, 'failed');
  assert.match(run.contestants[0].failReason ?? '', /最大 API 调用次数/);

  const chatty = await makeProvider({ name: 'notoolloop', baseUrl: `${base}/notoolloop/v1` });
  const noToolRun = new Run([E(chatty)], D3, { ...DEFAULT_LIMITS, maxApiCalls: 10 });
  await noToolRun.start();
  assert.equal(noToolRun.contestants[0].status, 'failed');
  assert.match(noToolRun.contestants[0].failReason ?? '', /连续 3 次未调用工具/);

  mock.delayMs = 80;
  const slow = await makeProvider({ name: 'slow-budget', baseUrl: `${base}/slow-budget/v1` });
  const durationRun = new Run([E(slow)], D3, { ...DEFAULT_LIMITS, maxDurationSec: 0.02, requestTimeoutSec: 1 });
  await durationRun.start();
  assert.equal(durationRun.contestants[0].status, 'failed');
  assert.match(durationRun.contestants[0].failReason ?? '', /最大运行时间/);
  mock.delayMs = 0;
});

test('多工具响应：拒绝基于同一旧状态的并行调用后允许模型恢复', async () => {
  const cfg = await makeProvider({ name: 'parallel', baseUrl: `${base}/parallel/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(run.contestants[0].status, 'solved');
  assert.equal(run.contestants[0].snapshot().stats.moves, mock.solution.length);
  const calls = mock.calls.filter((c) => c.path.startsWith('/parallel/'));
  assert.ok(calls[1].body.messages.some((m: any) => m.role === 'tool' && /PARALLEL_TOOL_CALLS_UNSUPPORTED/.test(m.content)));
});

test('arguments 规范化：Chat adapter 将 object arguments 转成 JSON 字符串后回放', async () => {
  const cfg = await makeProvider({ name: 'objectargs', baseUrl: `${base}/objectargs/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(run.contestants[0].status, 'solved');
  const calls = mock.calls.filter((c) => c.path.startsWith('/objectargs/'));
  assert.equal(typeof calls[1].body.messages.find((m: any) => m.role === 'assistant').tool_calls[0].function.arguments, 'string');
});

test('malformed arguments：非法 JSON 不会进入下一轮 replay', async () => {
  const cfg = await makeProvider({ name: 'malformed', baseUrl: `${base}/malformed/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(run.contestants[0].status, 'solved');
  const calls = mock.calls.filter((c) => c.path.startsWith('/malformed/'));
  const replayCall = calls[1].body.messages.find((m: any) => m.role === 'assistant');
  assert.equal(replayCall.tool_calls[0].function.arguments, '{}');
});

test('unknown tool：未声明工具不会进入下一轮 provider replay', async () => {
  const cfg = await makeProvider({ name: 'unknown-tool', baseUrl: `${base}/unknown-tool/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS });
  await run.start();
  assert.equal(run.contestants[0].status, 'failed');
  const calls = mock.calls.filter((c) => c.path.startsWith('/unknown-tool/'));
  assert.ok(calls.every((c) => !JSON.stringify(c.body).includes('move_center_piece')));
});

test('上下文硬预算：系统与工具定义已占满预算时不发送超预算请求', async () => {
  const cfg = await makeProvider({ name: 'context-budget', baseUrl: `${base}/context-budget/v1` });
  mock.calls = [];
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS, maxContextChars: 100 });
  await run.start();
  assert.equal(run.contestants[0].status, 'failed');
  assert.match(run.contestants[0].failReason ?? '', /上下文预算/);
  assert.equal(mock.calls.filter((c) => c.path.startsWith('/context-budget/')).length, 0);
});

test('看门狗：canonical state 连续不变时按无进展预算确定性失败', async () => {
  const cfg = await makeProvider({ name: 'stuck', baseUrl: `${base}/stuck/v1` });
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS, maxNoProgressCalls: 2 });
  await run.start();
  const contestant = run.contestants[0];
  assert.equal(contestant.status, 'failed');
  assert.match(contestant.failReason ?? '', /连续 2 次状态没有变化/);
  assert.equal(contestant.snapshot().stats.moves, 8);
});

test('取消：retry backoff 可被 stop 立即打断', async () => {
  const cfg = await makeProvider({ name: 'cancel-backoff', baseUrl: `${base}/cancel-backoff/v1` });
  const run = new Run([E(cfg)], D3, { ...DEFAULT_LIMITS, maxDurationSec: 60 });
  const started = Date.now();
  const done = run.start();
  for (let i = 0; i < 50 && !mock.calls.some((c) => c.path.startsWith('/cancel-backoff/')); i++) await new Promise((r) => setTimeout(r, 5));
  run.contestants[0].stop('测试取消');
  await done;
  assert.equal(run.contestants[0].status, 'stopped');
  assert.ok(Date.now() - started < 500, '停止不应等待退避计时器结束');
});

test('取消边界：暂停排队 contestant 不会在名额释放后直接发请求', async () => {
  const configs = await Promise.all([
    makeProvider({ name: 'pause-queue-a', baseUrl: `${base}/limited/v1`, maxConcurrentRequests: 1 }),
    makeProvider({ name: 'pause-queue-b', baseUrl: `${base}/limited/v1`, maxConcurrentRequests: 1 }),
  ]);
  mock.calls = [];
  mock.delayMs = 100;
  const run = new Run(configs.map((c) => E(c)), D3, { ...DEFAULT_LIMITS, concurrency: 1 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  const done = run.start();
  for (let i = 0; i < 50 && mock.calls.filter((c) => c.path.startsWith('/limited/')).length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(run.contestants[1].status, 'queued');
  assert.equal(run.contestants[1].pause(), true);
  run.contestants[0].stop('释放排队名额');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(run.contestants[1].status, 'paused');
  assert.equal(mock.calls.filter((c) => c.path.startsWith('/limited/')).length, 1);
  run.contestants[1].resume();
  await done;
  assert.equal(run.contestants[1].status, 'solved');
  mock.delayMs = 0;
});

test('运行配置：全局并发环境变量和可取消等待采用确定性边界', async () => {
  assert.equal(positiveIntEnv('0', 16), 16);
  assert.equal(positiveIntEnv('-1', 16), 16);
  assert.equal(positiveIntEnv('1.5', 16), 16);
  assert.equal(positiveIntEnv('3', 16), 3);
  const controller = new AbortController();
  const started = Date.now();
  const waiting = abortableDelay(30_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  assert.ok(Date.now() - started < 200);
});

test('单局 concurrency 限制实际控制 in-flight 请求数', async () => {
  const configs = await Promise.all([1, 2, 3, 4].map((i) => makeProvider({ name: `run-limit-${i}`, baseUrl: `${base}/limited/v1` })));
  mock.calls = [];
  mock.delayMs = 80;
  maxInFlight = 0;
  const run = new Run(configs.map((c) => E(c)), D3, { ...DEFAULT_LIMITS, concurrency: 2 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  assert.equal(maxInFlight, 2);
  for (const c of run.contestants) assert.equal(c.status, 'solved');
  mock.delayMs = 0;
});

test('工具契约按魔方阶数和单次动作上限生成 schema', () => {
  const tool = rotateCubeTool({ ...DEFAULT_LIMITS, maxMovesPerCall: 3 }, 4);
  assert.match(tool.description, /4x4x4/);
  assert.match(tool.description, /canonical state/);
  const moves = tool.parameters.properties as any;
  assert.equal(moves.moves.minItems, 1);
  assert.equal(moves.moves.maxItems, 3);
  assert.equal(moves.moves.items.enum.length, 18);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(moves.plan.maxLength, 600);
});

test('系统提示按结构化区块表达状态、工具、错误和终止契约', () => {
  const prompt = systemPrompt({ ...DEFAULT_LIMITS, maxNoToolCalls: 2, maxNoProgressCalls: 4 }, 4);
  for (const block of ['<role>', '<objective>', '<runtime_limits>', '<state_contract>', '<tool_policy>', '<loop>', '<error_recovery>', '<termination>', '<response_policy>']) {
    assert.ok(prompt.includes(block), block);
  }
  assert.match(prompt, /连续无工具阈值：2/);
  assert.match(prompt, /连续无进展阈值：4/);
  assert.match(prompt, /只有工具返回 solved=true 才算成功/);
});

test('每轮记忆：只给当前状态、最近执行的动作和模型自己的计划，不评价进展', () => {
  const state = applyMoves(solvedState(3), parseAlg('R U'));
  const first = turnMessage(state, { recent: [], plan: null });
  assert.ok(first.includes('展开图：') && first.includes('逐面格子：'));
  assert.match(first, /state_hash/);
  assert.match(first, /canonical state/);
  assert.ok(!first.includes('最近的调用'));
  const msg = turnMessage(state, {
    recent: [{ n: 3, moves: ['F'] }, { n: 4, moves: ['U2', 'R', 'U', "R'"] }, { n: 5, moves: [], error: '非法记号：X，整次调用未执行' }],
    plan: { n: 4, text: '插入 DFR 角块' },
  });
  assert.ok(msg.includes("最近的调用（从旧到新）：\n#3 F\n#4 U2 R U R'\n#5 未执行：非法记号：X，整次调用未执行"));
  assert.ok(msg.includes('模型在第 4 次调用时记下的备注（仅供参考）：插入 DFR 角块'));
  assert.ok(!/已归位|变好|变差|撤销/.test(msg), '不告诉模型变好还是变差');
  const noTool = turnMessage(state, { recent: [{ n: 2, moves: [], error: '未调用工具' }], plan: null, notes: ['请调用工具'] });
  assert.ok(noTool.includes('#2 未执行：未调用工具'));
  assert.ok(noTool.includes('请调用工具'));
});

test.after(() => server.close());
