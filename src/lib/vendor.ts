import type { Vendor } from '../components/BrandIcons.tsx';

/** 根据模型名或接口主机推断厂商（仅用于展示图标；推断不出返回 null） */
export function vendorOf(model: string, host = ''): Exclude<Vendor, 'more'> | null {
  const m = model.toLowerCase();
  // 同时适用于模型名与服务商名
  if (/^(gpt|o\d|chatgpt|text-|davinci)|openai/.test(m)) return 'openai';
  if (/claude|anthropic/.test(m)) return 'anthropic';
  if (/gemini|gemma|google/.test(m)) return 'google';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/qwen|qwq|alibaba|dashscope|通义/.test(m)) return 'qwen';
  const h = host.toLowerCase();
  if (h.includes('openai.com')) return 'openai';
  if (h.includes('anthropic.com')) return 'anthropic';
  if (h.includes('googleapis.com')) return 'google';
  if (h.includes('deepseek.com')) return 'deepseek';
  if (h.includes('dashscope') || h.includes('aliyun')) return 'qwen';
  return null;
}

export const VENDOR_NAME: Record<Exclude<Vendor, 'more'>, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
  qwen: 'Alibaba Qwen',
};
