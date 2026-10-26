import { authHeaders, postJson, ProviderError } from './http.ts';
import { contextTimeout, normalizeArguments, normalizeToolCallId, normalizeToolName, parseArgs, reportedCost, usageNum, type ProtocolAdapter, type ToolCall, type Turn } from './types.ts';

/** OpenAI Responses API（input items / function_call / function_call_output） */
function toInput(turns: Turn[]) {
  const items: Record<string, unknown>[] = [];
  for (const t of turns) {
    if (t.role === 'user') items.push({ role: 'user', content: t.text });
    else if (t.role === 'assistant') {
      for (const it of (Array.isArray(t.raw) ? t.raw : []) as Record<string, any>[]) {
        if (it.type === 'function_call') {
          // Keep the complete output item. call_id is the stable association used by
          // function_call_output; id and provider-specific metadata are retained too.
          items.push({ ...it, type: 'function_call', call_id: it.call_id ?? it.id, name: it.name, arguments: it.arguments });
        } else if (it.type === 'message') {
          const text = typeof it.content === 'string' ? it.content : (it.content ?? []).map((c: any) => c.text ?? '').join('');
          if (text) {
            const { content: _content, ...metadata } = it;
            items.push({ ...metadata, type: 'message', role: 'assistant', content: text });
          }
        } else if (it.type === 'reasoning') {
          // Preserve summary, content, encrypted_content, id and any future metadata.
          // Empty reasoning items have no replayable context and are omitted.
          const summary = Array.isArray(it.summary) ? it.summary : [];
          const content = Array.isArray(it.content) ? it.content : [];
          if (it.encrypted_content || summary.length || content.length) items.push({ ...it });
        }
      }
    } else {
      for (const r of t.results) items.push({ type: 'function_call_output', call_id: r.callId, output: r.content });
    }
  }
  return items;
}

const reasoningSummaryUnsupported = new Set<string>();
const encryptedReasoningUnsupported = new Set<string>();
const reasoningEffortUnsupported = new Set<string>();

function optionalReasoningOption(error: unknown, option: 'summary' | 'encrypted'): boolean {
  if (!(error instanceof ProviderError) || error.status !== 400) return false;
  const message = error.message;
  if (option === 'summary') return /reasoning(?:[._\s-])?summary\b/i.test(message);
  return /reasoning[._\s-]?encrypted[_ .-]?content|encrypted[_ .-]?content/i.test(message) ||
    (/\binclude\b/i.test(message) && /unsupported|unrecognized|unknown|not supported/i.test(message));
}

function optionalReasoningEffort(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 400 && /reasoning(?:[._\s-])?effort\b/i.test(error.message);
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  async call(ctx) {
    const { config } = ctx;
    const modelKey = `${config.id}\0${ctx.endpoint}\0${ctx.model}`;
    const body: Record<string, unknown> = {
      model: ctx.model,
      instructions: ctx.system,
      input: toInput(ctx.turns),
      store: false,
    };
    if (ctx.tools.length) {
      body.tools = ctx.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
      body.tool_choice = ctx.toolChoice;
      body.parallel_tool_calls = false;
    }
    if (ctx.reasoningEffort !== 'default' && !reasoningSummaryUnsupported.has(modelKey)) {
      body.reasoning = {
        ...(!reasoningEffortUnsupported.has(modelKey) ? { effort: ctx.reasoningEffort } : {}),
        summary: 'concise',
      };
    } else if (ctx.reasoningEffort !== 'default' && !reasoningEffortUnsupported.has(modelKey)) {
      body.reasoning = { effort: ctx.reasoningEffort };
    }
    if (ctx.reasoningEffort !== 'default' && !encryptedReasoningUnsupported.has(modelKey)) {
      body.include = ['reasoning.encrypted_content'];
    }
    if (ctx.maxOutputTokens) body.max_output_tokens = ctx.maxOutputTokens;

    const send = () => postJson(ctx.endpoint, authHeaders(config.authMode, ctx.apiKey), body, {
      signal: ctx.signal,
      timeoutMs: contextTimeout(ctx),
      secrets: [ctx.apiKey],
    });
    let json: any;
    for (;;) {
      try {
        ({ json } = await send());
        break;
      } catch (e) {
        // Older OpenAI-compatible relays reject the optional reasoning fields. Retry
        // once with only the core request and remember the capability per endpoint/model.
        if (body.include && optionalReasoningOption(e, 'encrypted')) {
          encryptedReasoningUnsupported.add(modelKey);
          delete body.include;
          continue;
        }
        if (body.reasoning && (body.reasoning as Record<string, unknown>).summary && optionalReasoningOption(e, 'summary')) {
          reasoningSummaryUnsupported.add(modelKey);
          const { summary: _summary, ...reasoning } = body.reasoning as Record<string, unknown>;
          if (Object.keys(reasoning).length) body.reasoning = reasoning;
          else delete body.reasoning;
          continue;
        }
        if (body.reasoning && (body.reasoning as Record<string, unknown>).effort && optionalReasoningEffort(e)) {
          reasoningEffortUnsupported.add(modelKey);
          const { effort: _effort, ...reasoning } = body.reasoning as Record<string, unknown>;
          if (Object.keys(reasoning).length) body.reasoning = reasoning;
          else delete body.reasoning;
          continue;
        }
        throw e;
      }
    }
    if (!Array.isArray(json?.output)) throw new ProviderError('parse', '响应中缺少 output 数组（该地址可能不支持 Responses API）');
    const toolCalls: ToolCall[] = [];
    let text = '';
    const thoughts: string[] = [];
    const rawOutput: Record<string, any>[] = [];
    for (const [index, it] of (json.output as Record<string, any>[]).entries()) {
      if (it?.type !== 'function_call') {
        rawOutput.push(it);
        continue;
      }
      const name = normalizeToolName(it.name);
      if (!name) continue;
      const callId = normalizeToolCallId(it.call_id ?? it.id, `responses_call_${index}`);
      rawOutput.push({ ...it, id: it.id ?? callId, call_id: callId, name, arguments: normalizeArguments(it.arguments) });
    }
    for (const it of rawOutput) {
      if (it.type === 'function_call') {
        toolCalls.push({ id: String(it.call_id), name: String(it.name), ...parseArgs(it.arguments) });
      } else if (it.type === 'message') {
        text += (it.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
      } else if (it.type === 'reasoning') {
        // 推理摘要（summary_text），开源推理模型可能直接给出 reasoning_text
        for (const p of [...(it.summary ?? []), ...(it.content ?? [])]) if (typeof p?.text === 'string' && p.text.trim()) thoughts.push(p.text.trim());
      }
    }
    const u = json.usage;
    return {
      text,
      reasoning: thoughts.join('\n\n'),
      toolCalls,
      raw: rawOutput,
      finishReason: json.status ?? null,
      truncated: json.status === 'incomplete' && json.incomplete_details?.reason === 'max_output_tokens',
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
