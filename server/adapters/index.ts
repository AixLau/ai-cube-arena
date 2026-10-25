import type { ProtocolId } from '../../shared/types.ts';
import { anthropicAdapter } from './anthropic.ts';
import { geminiAdapter } from './gemini.ts';
import { openaiChatAdapter } from './openaiChat.ts';
import { openaiResponsesAdapter } from './openaiResponses.ts';
import type { ProtocolAdapter } from './types.ts';

/** 各协议独立适配，新增协议只需实现 ProtocolAdapter 并在此注册 */
export const ADAPTERS: Record<ProtocolId, ProtocolAdapter> = {
  'openai-chat': openaiChatAdapter,
  'openai-responses': openaiResponsesAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};
