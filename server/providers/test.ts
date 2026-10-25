import { displayEndpoint, resolveEndpoint } from '../../shared/endpoint.ts';
import type { ConnectionTestResult, ProviderConfig } from '../../shared/types.ts';
import { ADAPTERS } from '../adapters/index.ts';
import { ProviderError } from '../adapters/http.ts';
import type { ToolSpec } from '../adapters/types.ts';

const PING_TOOL: ToolSpec = {
  name: 'ping',
  description: 'Connectivity check. Call this tool with echo set to "cube".',
  parameters: {
    type: 'object',
    properties: { echo: { type: 'string', description: 'Must be the word cube' } },
    required: ['echo'],
  },
};

const TOOL_REJECT_RE = /tool|function|tool_choice|functionDeclarations|不支持.*(工具|函数)/i;

function hintsFor(err: ProviderError, cfg: ProviderConfig, endpoint: string): string[] {
  const hints: string[] = [];
  let path = '';
  try {
    path = new URL(endpoint).pathname;
  } catch {
    /* ignore */
  }
  if (err.status === 401 || err.status === 403) hints.push('API Key 无效、已过期，或认证方式（Bearer / x-api-key）与该接口不匹配。');
  if (err.status === 404) {
    if ((cfg.protocol === 'openai-chat' || cfg.protocol === 'openai-responses') && !/\/v\d/.test(path)) {
      hints.push('Base URL 中没有版本路径。多数 OpenAI 兼容接口需要以 /v1 结尾（例如 https://example.com/v1），本系统不会自动追加。');
    }
    if (/\/v1\/v1\//.test(path)) hints.push('最终地址中出现了重复的 /v1，请去掉 Base URL 末尾多余的 /v1。');
    hints.push('也可能是模型 ID 不存在，或该中转站不支持当前协议。');
  }
  if (err.status === 400 && /model/i.test(err.message)) hints.push('请确认模型 ID 拼写与该供应商一致。');
  if (err.status === 429) hints.push('请求被限流或余额不足。');
  if (err.kind === 'parse') hints.push('响应格式与所选协议不一致，请确认接口协议类型。');
  return hints;
}

export async function testConnection(cfg: ProviderConfig, apiKey: string | undefined, model: string): Promise<ConnectionTestResult> {
  const endpoint = resolveEndpoint(cfg.protocol, cfg.baseUrl, model);
  const shown = displayEndpoint(endpoint);
  const base: ConnectionTestResult = {
    ok: false, endpoint: shown, latencyMs: null, httpStatus: null, message: '', toolSupport: 'unknown',
    toolMessage: '', usageReported: false, hints: [],
  };
  if (!apiKey && cfg.authMode !== 'none') {
    return { ...base, message: '尚未设置 API Key（服务重启后，未加密保存的密钥需要重新输入）。' };
  }

  const adapter = ADAPTERS[cfg.protocol];
  const ctx = {
    config: cfg,
    model,
    reasoningEffort: 'default' as const,
    endpoint,
    apiKey,
    system: 'You are a connectivity test assistant. Follow the instruction exactly.',
    turns: [{ role: 'user' as const, text: 'Call the ping tool now with echo set to "cube". Do not reply with text.' }],
    toolChoice: 'auto' as const,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
  };

  const started = Date.now();
  try {
    const r = await adapter.call({ ...ctx, tools: [PING_TOOL] });
    const call = r.toolCalls.find((c) => c.name === 'ping');
    const toolSupport = call ? 'supported' : 'not_called';
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - started,
      httpStatus: 200,
      message: '连接成功。',
      toolSupport,
      toolMessage: call
        ? `模型正确发起了工具调用（参数：${JSON.stringify(call.args ?? {}).slice(0, 80)}）。`
        : `接口接受了工具定义，但模型没有调用工具，而是返回了文本${r.text ? `：「${r.text.slice(0, 80)}」` : ''}。该模型可能不支持或不擅长工具调用。`,
      usageReported: !!r.usage && (r.usage.input !== null || r.usage.output !== null),
    };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('network', '未知错误');
    const latencyMs = Date.now() - started;
    // 带工具请求被拒时，去掉工具再试一次，区分「无法连接」与「不支持工具调用」
    if (err.status === 400 && TOOL_REJECT_RE.test(err.message)) {
      try {
        const r = await adapter.call({ ...ctx, tools: [], turns: [{ role: 'user', text: 'Reply with the single word: ok' }] });
        return {
          ...base,
          ok: true,
          latencyMs: Date.now() - started,
          httpStatus: 200,
          message: '连接成功（不带工具的请求可用）。',
          toolSupport: 'rejected',
          toolMessage: `接口拒绝了工具定义：${err.message}。该接口或模型不支持工具调用，无法参加魔方评测。`,
          usageReported: !!r.usage,
          detail: err.detail,
        };
      } catch {
        /* 落入下方的失败结果 */
      }
    }
    return {
      ...base,
      latencyMs: err.kind === 'url' ? null : latencyMs,
      httpStatus: err.status,
      message: err.message,
      detail: err.detail || undefined,
      hints: hintsFor(err, cfg, endpoint),
    };
  }
}
