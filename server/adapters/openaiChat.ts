import { authHeaders, postJson, ProviderError } from './http.ts';
import { contextTimeout, normalizeArguments, normalizeToolCallId, normalizeToolName, parseArgs, reportedCost, splitThinkTags, usageNum, type ProtocolAdapter, type ToolCall, type Turn } from './types.ts';

/** OpenAI 兼容 Chat Completions（tools / tool_calls / role=tool） */
function toMessages(system: string, turns: Turn[]) {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const t of turns) {
    if (t.role === 'user') messages.push({ role: 'user', content: t.text });
    else if (t.role === 'assistant') {
      const raw = (t.raw ?? {}) as Record<string, unknown>;
      const msg: Record<string, unknown> = { role: 'assistant', content: raw.content ?? (t.text || null) };
      if (Array.isArray(raw.tool_calls) && raw.tool_calls.length) msg.tool_calls = raw.tool_calls;
      // DeepSeek / Kimi 等思考模式要求在同一轮工具调用中回传 reasoning_content；仅当对方返回过才回传
      if (typeof raw.reasoning_content === 'string') msg.reasoning_content = raw.reasoning_content;
      messages.push(msg);
    } else {
      for (const r of t.results) messages.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
    }
  }
  return messages;
}

/**
 * OpenAI 的 o 系列 / gpt-5 等推理模型拒绝 max_tokens，只接受 max_completion_tokens；
 * 多数兼容接口则只认 max_tokens。默认发送 max_tokens，被点名拒绝后改用新字段并按 端点 + 模型 记住。
 */
const completionTokensModels = new Set<string>();

export const openaiChatAdapter: ProtocolAdapter = {
  async call(ctx) {
    const { config } = ctx;
    const body: Record<string, unknown> = {
      model: ctx.model,
      messages: toMessages(ctx.system, ctx.turns),
      stream: false,
    };
    if (ctx.tools.length) {
      body.tools = ctx.tools.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = ctx.toolChoice;
      // rotate_cube mutates shared per-contestant state; calls from one response must be ordered.
      body.parallel_tool_calls = false;
    }
    if (ctx.reasoningEffort !== 'default') body.reasoning_effort = ctx.reasoningEffort;
    const modelKey = `${ctx.endpoint}\0${ctx.model}`;
    if (ctx.maxOutputTokens) body[completionTokensModels.has(modelKey) ? 'max_completion_tokens' : 'max_tokens'] = ctx.maxOutputTokens;

    const send = (b: Record<string, unknown>) =>
      postJson(ctx.endpoint, authHeaders(config.authMode, ctx.apiKey), b, { signal: ctx.signal, timeoutMs: contextTimeout(ctx), secrets: [ctx.apiKey] });
    let json;
    try {
      ({ json } = await send(body));
    } catch (e) {
      if (!(e instanceof ProviderError) || e.status !== 400 || body.max_tokens === undefined || !/max_completion_tokens/.test(e.message)) throw e;
      completionTokensModels.add(modelKey);
      const { max_tokens, ...rest } = body;
      ({ json } = await send({ ...rest, max_completion_tokens: max_tokens }));
    }
    const choice = json?.choices?.[0];
    if (!choice?.message) throw new ProviderError('parse', '响应中缺少 choices[0].message');
    const message = choice.message;
    const normalizedCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
      .map((c: any, i: number) => {
        const name = normalizeToolName(c?.function?.name);
        if (!name) return null;
        return {
          ...c,
          id: normalizeToolCallId(c?.id, `chat_call_${i}`),
          type: c.type ?? 'function',
          function: { ...c.function, name, arguments: normalizeArguments(c?.function?.arguments) },
        };
      })
      .filter(Boolean) as any[];
    const toolCalls: ToolCall[] = normalizedCalls.map((c: any) => ({
      id: c.id,
      name: String(c.function.name),
      ...parseArgs(c.function.arguments),
    }));
    // 缺少 id 的工具调用补齐；没有函数名的 malformed call 不回放，避免下一轮缺少对应 tool result。
    const raw = {
      ...message,
      tool_calls: normalizedCalls.length ? normalizedCalls : undefined,
    };
    // 思考字段：DeepSeek / Kimi / Qwen 等用 reasoning_content，OpenRouter / Ollama 等用 reasoning；也可能以 <think> 写在正文
    const own = [message.reasoning_content, message.reasoning].find((v) => typeof v === 'string' && v.trim()) ?? '';
    const split = splitThinkTags(typeof message.content === 'string' ? message.content : '');
    const u = json.usage;
    return {
      text: split.text,
      reasoning: [own, split.reasoning].filter(Boolean).join('\n\n'),
      toolCalls,
      raw,
      finishReason: choice.finish_reason ?? null,
      truncated: choice.finish_reason === 'length',
      usage: u
        ? {
            input: usageNum(u.prompt_tokens),
            output: usageNum(u.completion_tokens),
            reasoning: usageNum(u.completion_tokens_details?.reasoning_tokens),
            cost: reportedCost(u),
          }
        : null,
    };
  },
};
