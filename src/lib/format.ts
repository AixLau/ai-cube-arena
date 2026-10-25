import type { ContestantStats, ContestantStatus, KeySource, ProtocolId, ReasoningEffort } from '../../shared/types.ts';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** 费用只显示供应商返回的计费金额（单位以供应商为准）；未返回时显示「未知」，不估算 */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return '未知';
  if (cost === 0) return '0';
  return cost < 0.01 ? cost.toFixed(5) : cost.toFixed(cost < 1 ? 4 : 2);
}

export function formatTokens(n: number | null): string {
  if (n === null) return '未知';
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 1 : 2)} 万`;
  return n.toLocaleString('zh-CN');
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const STATUS_TEXT: Record<ContestantStatus | 'idle', string> = {
  idle: '待开始',
  queued: '排队中',
  running: '求解中',
  paused: '已暂停',
  solved: '复原成功',
  failed: '未能复原',
  stopped: '已停止',
  error: '出错',
};

export const KEY_SOURCE_TEXT: Record<KeySource, string> = {
  none: '未设置密钥',
  memory: '密钥仅在内存（重启失效）',
  encrypted: '密钥已加密保存',
  env: '服务端环境变量',
};

export const PROTOCOL_SHORT: Record<ProtocolId, string> = {
  'openai-chat': 'Chat Completions',
  'openai-responses': 'Responses',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

/** 用量部分缺失时的说明 */
export function usageNote(s: ContestantStats): string | undefined {
  return s.usageMissingCalls ? `${s.usageMissingCalls} 次调用未返回用量` : undefined;
}

export const EFFORT_TEXT: Record<ReasoningEffort, string> = { default: '默认', low: '低', medium: '中', high: '高' };
