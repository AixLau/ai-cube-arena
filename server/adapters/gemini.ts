import { authHeaders, postJson, ProviderError } from './http.ts';
import { reportedCost, THINKING_BUDGET, usageNum, type ProtocolAdapter, type ToolCall, type Turn } from './types.ts';

/** Google Gemini generateContent（functionCall / functionResponse） */
function toContents(turns: Turn[]) {
  const contents: { role: 'user' | 'model'; parts: unknown[] }[] = [];
  const push = (role: 'user' | 'model', parts: unknown[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const t of turns) {
    if (t.role === 'user') push('user', [{ text: t.text }]);
    else if (t.role === 'assistant') {
      // 原样回放 parts（含 thoughtSignature）
      push('model', Array.isArray(t.raw) ? t.raw : [{ text: t.text || '（无内容）' }]);
    } else {
      push(
        'user',
        t.results.map((r) => ({
          functionResponse: { ...(r.callId.startsWith('gem_') ? {} : { id: r.callId }), name: r.name, response: { result: r.content } },
        })),
      );
    }
  }
  return contents;
}

export const geminiAdapter: ProtocolAdapter = {
  async call(ctx) {
    const { config } = ctx;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: ctx.system }] },
      contents: toContents(ctx.turns),
    };
    if (ctx.tools.length) {
      body.tools = [{ functionDeclarations: ctx.tools }];
      body.toolConfig = { functionCallingConfig: { mode: ctx.toolChoice === 'required' ? 'ANY' : 'AUTO' } };
    }
    if (ctx.reasoningEffort !== 'default') {
      body.generationConfig = { thinkingConfig: { thinkingBudget: THINKING_BUDGET[ctx.reasoningEffort] } };
    }

    const { json } = await postJson(ctx.endpoint, authHeaders(config.authMode, ctx.apiKey), body, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      secrets: [ctx.apiKey],
    });
    const cand = json?.candidates?.[0];
    if (!cand) {
      const reason = json?.promptFeedback?.blockReason;
      throw new ProviderError('parse', reason ? `请求被拦截：${reason}` : '响应中缺少 candidates（该地址可能不是 Gemini 协议）');
    }
    const parts: any[] = cand.content?.parts ?? [];
    const toolCalls: ToolCall[] = [];
    let text = '';
    parts.forEach((p, i) => {
      if (p.functionCall) {
        const args = p.functionCall.args;
        const ok = !args || (typeof args === 'object' && !Array.isArray(args));
        toolCalls.push({
          id: String(p.functionCall.id ?? `gem_${Date.now()}_${i}`),
          name: String(p.functionCall.name),
          args: ok ? (args ?? {}) : null,
          argsError: ok ? undefined : '工具参数不是 JSON 对象',
        });
      } else if (typeof p.text === 'string' && !p.thought) text += p.text;
    });
    const u = json.usageMetadata;
    const candidates = usageNum(u?.candidatesTokenCount);
    const thoughts = usageNum(u?.thoughtsTokenCount);
    return {
      text,
      toolCalls,
      raw: parts,
      finishReason: cand.finishReason ?? null,
      // Gemini 的思考 Token 单独计数且按输出计费：输出 = candidates + thoughts，推理 = thoughts
      usage: u
        ? {
            input: usageNum(u.promptTokenCount),
            output: candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0),
            reasoning: thoughts,
            cost: reportedCost(u),
          }
        : null,
    };
  },
};
