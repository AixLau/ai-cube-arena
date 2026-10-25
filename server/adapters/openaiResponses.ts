import { authHeaders, postJson, ProviderError } from './http.ts';
import { parseArgs, reportedCost, usageNum, type ProtocolAdapter, type ToolCall, type Turn } from './types.ts';

/** OpenAI Responses API（input items / function_call / function_call_output） */
function toInput(turns: Turn[]) {
  const items: Record<string, unknown>[] = [];
  for (const t of turns) {
    if (t.role === 'user') items.push({ role: 'user', content: t.text });
    else if (t.role === 'assistant') {
      for (const it of (Array.isArray(t.raw) ? t.raw : []) as Record<string, any>[]) {
        if (it.type === 'function_call') {
          // 不回传 id，避免引用未保存（store=false）的服务端条目
          items.push({ type: 'function_call', call_id: it.call_id, name: it.name, arguments: it.arguments });
        } else if (it.type === 'message') {
          const text = (it.content ?? []).map((c: any) => c.text ?? '').join('');
          if (text) items.push({ role: 'assistant', content: text });
        } else if (it.type === 'reasoning' && it.encrypted_content) {
          items.push({ type: 'reasoning', summary: it.summary ?? [], encrypted_content: it.encrypted_content });
        }
      }
    } else {
      for (const r of t.results) items.push({ type: 'function_call_output', call_id: r.callId, output: r.content });
    }
  }
  return items;
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  async call(ctx) {
    const { config } = ctx;
    const body: Record<string, unknown> = {
      model: ctx.model,
      instructions: ctx.system,
      input: toInput(ctx.turns),
      store: false,
    };
    if (ctx.tools.length) {
      body.tools = ctx.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
      body.tool_choice = ctx.toolChoice;
    }
    if (ctx.reasoningEffort !== 'default') body.reasoning = { effort: ctx.reasoningEffort };

    const { json } = await postJson(ctx.endpoint, authHeaders(config.authMode, ctx.apiKey), body, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      secrets: [ctx.apiKey],
    });
    if (!Array.isArray(json?.output)) throw new ProviderError('parse', '响应中缺少 output 数组（该地址可能不支持 Responses API）');
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const it of json.output) {
      if (it.type === 'function_call') {
        toolCalls.push({ id: String(it.call_id ?? it.id), name: String(it.name), ...parseArgs(it.arguments) });
      } else if (it.type === 'message') {
        text += (it.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
      }
    }
    const u = json.usage;
    return {
      text,
      toolCalls,
      raw: json.output,
      finishReason: json.status ?? null,
      usage: u
        ? {
            input: usageNum(u.input_tokens),
            output: usageNum(u.output_tokens),
            reasoning: usageNum(u.output_tokens_details?.reasoning_tokens),
            cost: reportedCost(u),
          }
        : null,
    };
  },
};
