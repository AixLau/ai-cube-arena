import { authHeaders, postJson, ProviderError } from './http.ts';
import { parseArgs, reportedCost, usageNum, type ProtocolAdapter, type ToolCall, type Turn } from './types.ts';

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
    }
    if (ctx.reasoningEffort !== 'default') body.reasoning_effort = ctx.reasoningEffort;

    const { json } = await postJson(ctx.endpoint, authHeaders(config.authMode, ctx.apiKey), body, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      secrets: [ctx.apiKey],
    });
    const choice = json?.choices?.[0];
    if (!choice?.message) throw new ProviderError('parse', '响应中缺少 choices[0].message');
    const message = choice.message;
    const toolCalls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
      .filter((c: any) => c?.function?.name)
      .map((c: any, i: number) => ({
        id: String(c.id || `call_${Date.now()}_${i}`),
        name: String(c.function.name),
        ...parseArgs(c.function.arguments),
      }));
    // 缺少 id 的工具调用补齐，保证回放时 tool_call_id 能对应
    const raw = {
      ...message,
      tool_calls: Array.isArray(message.tool_calls)
        ? message.tool_calls.map((c: any, i: number) => ({ ...c, id: toolCalls[i]?.id ?? c.id, type: c.type ?? 'function' }))
        : undefined,
    };
    const u = json.usage;
    return {
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      raw,
      finishReason: choice.finish_reason ?? null,
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
