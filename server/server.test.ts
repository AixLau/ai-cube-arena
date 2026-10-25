import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试数据写入临时目录，必须在导入服务端模块之前设置
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'cube-arena-test-'));
delete process.env.DEEPSEEK_API_KEY;

const { resolveEndpoint } = await import('../shared/endpoint.ts');
const { assertAllowedUrl, isBlockedIp, safeLookup } = await import('./security/url.ts');
const { redact } = await import('./security/redact.ts');
const { createConfig, listConfigs, getApiKey, duplicateConfig } = await import('./providers/store.ts');
const { testConnection } = await import('./providers/test.ts');
const { Run } = await import('./arena/run.ts');
const { DIFFICULTIES, DEFAULT_LIMITS } = await import('../shared/types.ts');
const { invertAlg, formatAlg } = await import('../shared/cube.ts');

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
    if (url.endsWith('/responses')) {
      return json(200, {
        status: 'completed',
        output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'rotate_cube', arguments: JSON.stringify({ moves }) }],
        usage: { input_tokens: 80, output_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } },
      });
    }
    if (url.endsWith('/messages')) {
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      return json(200, {
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: '开始复原' }, { type: 'tool_use', id: 'tu_1', name: 'rotate_cube', input: { moves } }],
        usage: { input_tokens: 70, cache_read_input_tokens: 10, output_tokens: 40 },
      });
    }
    if (url.includes(':generateContent')) {
      return json(200, {
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'rotate_cube', args: { moves } }, thoughtSignature: 'sig' }] } }],
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
const E = (config: any, reasoningEffort: any = 'default', model = 'mock-model') => ({ config, model, reasoningEffort });

test('配置存储：密钥默认只在内存，接口不回传，环境预置复制不带密钥', async () => {
  const cfg = await createConfig(draft({}));
  assert.equal(cfg.keySource, 'memory');
  assert.ok(!JSON.stringify(await listConfigs()).includes('sk-test-1234567890abcdef'));
  assert.equal(await getApiKey(cfg.id), 'sk-test-1234567890abcdef');
  const copy = await duplicateConfig(cfg.id);
  assert.equal(await getApiKey(copy.id), 'sk-test-1234567890abcdef');
  await assert.rejects(createConfig(draft({ persistKey: true })), /CREDENTIAL_SECRET/);
});

test('测试连接：成功、工具支持、401 脱敏、重定向拒绝、不支持工具', async () => {
  const mk = (p: string) => ({ ...draft({ baseUrl: `${base}${p}` }), id: 'x', keySource: 'memory', createdAt: '', updatedAt: '' });
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
    await createConfig(draft({ name: 'chat' })),
    await createConfig(draft({ name: 'responses', protocol: 'openai-responses' })),
    await createConfig(draft({ name: 'anthropic', protocol: 'anthropic', baseUrl: base, authMode: 'x-api-key' })),
    await createConfig(draft({ name: 'gemini', protocol: 'gemini', baseUrl: `${base}/v1beta`, authMode: 'x-goog-api-key' })),
    await createConfig(draft({ name: 'bad', baseUrl: `${base}/bad/v1` })),
    await createConfig(draft({ name: 'nousage', baseUrl: `${base}/nousage/v1` })),
    await createConfig(draft({ name: 'wrong', baseUrl: `${base}/wrong/v1` })),
  ];
  mock.calls = [];
  mock.delayMs = 300;
  const run = new Run(configs.map((c) => E(c)), DIFFICULTIES[1], { ...DEFAULT_LIMITS, concurrency: 8 });
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

  // 模型拿不到打乱公式；所有模型收到相同的系统提示与初始状态
  const first = mock.calls.filter((c) => c.path.endsWith('/chat/completions') && c.body.tools?.[0]?.function?.name === 'rotate_cube');
  const sys = new Set(first.map((c) => c.body.messages[0].content));
  assert.equal(sys.size, 1);
  for (const c of mock.calls) assert.ok(!JSON.stringify(c.body).includes(scramble), '请求中不应出现打乱公式');
  // 请求中不出现其它选手或服务端的密钥以外的内容：Authorization 正确
  assert.equal(first[0].headers.authorization, 'Bearer sk-test-1234567890abcdef');
  // 每次请求只携带最新状态，不回放会造成 Token 线性累加的历史消息
  const wrongCalls = mock.calls.filter((c) => c.path.startsWith('/wrong/') && c.path.endsWith('/chat/completions'));
  assert.ok(wrongCalls.length >= 2);
  assert.ok(wrongCalls.every((c) => c.body.messages.filter((m: any) => m.role === 'assistant' || m.role === 'tool').length === 0));
  assert.ok(wrongCalls[1].body.messages[1].content.includes('上一轮工具执行摘要'));
  // 事件中不出现密钥
  assert.ok(!JSON.stringify(run.events).includes('sk-test-1234567890abcdef'));
  mock.delayMs = 0;
});

test('并发上限：concurrency=1 时依次运行，单个模型可停止且不影响其它', async () => {
  const configs = [await createConfig(draft({ name: 'a' })), await createConfig(draft({ name: 'b' }))];
  mock.delayMs = 200;
  const run = new Run(configs.map((c) => E(c)), DIFFICULTIES[0], { ...DEFAULT_LIMITS, concurrency: 1 });
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
  for (const d of shared) configs.push(await createConfig(d));
  const throttled = await createConfig(draft({ name: 'throttled', baseUrl: `${base}/throttle/v1` }));
  mock.delayMs = 150;
  maxInFlight = 0;
  throttleLeft = 2;
  const run = new Run([...configs, throttled].map((c) => E(c)), DIFFICULTIES[0], { ...DEFAULT_LIMITS, concurrency: 8 });
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
  const cfg = await createConfig(draft({ name: 'spin', baseUrl: `${base}/spin/v1` }));
  const run = new Run([E(cfg)], DIFFICULTIES[1], { ...DEFAULT_LIMITS, maxApiCalls: 40, concurrency: 1 });
  mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
  await run.start();
  const c = run.contestants[0].snapshot();
  assert.equal(c.status, 'solved');
  assert.equal(c.stats.moves, 260 + mock.solution.length);
  const spinCalls = mock.calls.filter((x) => x.path.startsWith('/spin/') && x.path.endsWith('/chat/completions'));
  assert.ok(spinCalls.every((x) => x.body.messages.length === 2), '长评测不能回放完整对话历史');
});

test('供应商：保存后自动获取模型列表；不支持列表时可手动补充', async () => {
  const cfg = await createConfig(draft({ name: undefined }));
  assert.deepEqual(cfg.models, ['mock-2', 'mock-model']);
  assert.equal(cfg.modelsError, null);
  assert.equal(cfg.name, new URL(base).host, '名称默认使用域名');
  const nolist = await createConfig(draft({ baseUrl: `${base}/nolist/v1`, manualModels: ['my-model'] }));
  assert.deepEqual(nolist.models, []);
  assert.match(nolist.modelsError ?? '', /手动/);
  assert.deepEqual(nolist.manualModels, ['my-model']);
});

test('推理强度：按协议发送参数；模型拒绝时去掉参数重试并标记', async () => {
  const ok = await createConfig(draft({ name: 'effort' }));
  const rejecting = await createConfig(draft({ name: 'noeffort', baseUrl: `${base}/noeffort/v1` }));
  mock.calls = [];
  const run = new Run([E(ok, 'high'), E(rejecting, 'low'), E(ok, 'default', 'mock-2')], DIFFICULTIES[0], { ...DEFAULT_LIMITS, concurrency: 4 });
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
  const cfg = await createConfig(draft({ name: 'nxn' }));
  for (const n of [2, 4]) {
    mock.calls = [];
    const run = new Run([E(cfg)], DIFFICULTIES[1], { ...DEFAULT_LIMITS, concurrency: 1 }, n);
    mock.solution = formatAlg(invertAlg(run.scramble)).split(' ');
    await run.start();
    assert.equal(run.contestants[0].status, 'solved', `${n} 阶`);
    assert.equal(run.summary().cubeSize, n);
    assert.equal(run.summary().initialState.length, 6 * n * n);
    assert.match(mock.calls[0].body.messages[0].content, new RegExp(`${n}×${n}×${n}`));
  }
});

test.after(() => server.close());
