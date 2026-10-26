import { authHeaders, postJson, ProviderError } from './http.ts';
import { contextTimeout, normalizeToolCallId, normalizeToolName, reportedCost, THINKING_BUDGET, usageNum, type ProtocolAdapter, type ToolCall, type Turn } from './types.ts';

/** Anthropic Messages API（tool_use / tool_result） */
function toMessages(turns: Turn[]) {
  const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: unknown[]) => {
    const last = messages[messages.length - 1];
    // 相邻同角色消息合并，满足 user/assistant 交替要求
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const t of turns) {
    if (t.role === 'user') push('user', [{ type: 'text', text: t.text }]);
    else if (t.role === 'assistant') {
      const blocks = Array.isArray(t.raw) ? t.raw : [{ type: 'text', text: t.text || '（无内容）' }];
      push('assistant', blocks);
    } else {
      push('user', t.results.map((r) => ({ type: 'tool_result', tool_use_id: r.callId, content: r.content })));
    }
  }
  return messages;
}

export const anthropicAdapter: ProtocolAdapter = {
  async call(ctx) {
    const { config } = ctx;
    const body: Record<string, unknown> = {
      model: ctx.model,
      system: ctx.system,
      messages: toMessages(ctx.turns),
      max_tokens: ctx.maxOutputTokens ?? 8192,
    };
    if (ctx.reasoningEffort !== 'default') {
      // Anthropic 要求 max_tokens 大于思考预算：输出上限叠加在预算之上
      const budget = THINKING_BUDGET[ctx.reasoningEffort];
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = budget + (ctx.maxOutputTokens ?? 8192);
    }
    if (ctx.tools.length) {
      body.tools = ctx.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      // 开启思考时 Anthropic 只允许 tool_choice=auto
      body.tool_choice = { type: ctx.toolChoice === 'required' && !body.thinking ? 'any' : 'auto', disable_parallel_tool_use: true };
    }

    const { json } = await postJson(
      ctx.endpoint,
      { ...authHeaders(config.authMode, ctx.apiKey), 'anthropic-version': '2023-06-01' },
      body,
      { signal: ctx.signal, timeoutMs: contextTimeout(ctx), secrets: [ctx.apiKey] },
    );
    if (!Array.isArray(json?.content)) throw new ProviderError('parse', '响应中缺少 content 数组（该地址可能不是 Anthropic 协议）');
    const toolCalls: ToolCall[] = [];
    const normalizedContent: any[] = [];
    const allowedTools = new Set(ctx.tools.map((tool) => tool.name));
    let text = '';
    const thoughts: string[] = [];
    for (const b of json.content) {
      if (b.type === 'tool_use') {
        const ok = b.input && typeof b.input === 'object' && !Array.isArray(b.input);
        const name = normalizeToolName(b.name, allowedTools);
        if (!name) continue;
        const id = normalizeToolCallId(b.id, `anthropic_call_${toolCalls.length}`);
        normalizedContent.push({ ...b, id, name, input: ok ? b.input : {} });
        toolCalls.push({ id, name, args: ok ? b.input : null, argsError: ok ? undefined : '工具参数不是 JSON 对象' });
      } else if (b.type === 'text') { normalizedContent.push(b); text += b.text ?? ''; }
      // redacted_thinking 只有密文，不展示
      else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) { normalizedContent.push(b); thoughts.push(b.thinking.trim()); }
      else if (b.type === 'redacted_thinking') normalizedContent.push(b);
    }
    const u = json.usage;
    const input = u
      ? [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].reduce<number | null>(
          (sum, v) => (typeof v === 'number' ? (sum ?? 0) + v : sum),
          null,
        )
      : null;
    return {
      text,
      reasoning: thoughts.join('\n\n'),
      toolCalls,
      raw: normalizedContent,
      finishReason: json.stop_reason ?? null,
      truncated: json.stop_reason === 'max_tokens',
      forcedToolSupported: !body.thinking,
      // Anthropic 的 output_tokens 已包含思考 Token，且不单独给出，推理 Token 记为未知
      usage: u ? { input, output: usageNum(u.output_tokens), reasoning: null, cost: reportedCost(u) } : null,
    };
  },
};
