import type {
  ConnectionTestResult, Difficulty, ProtocolInfo, ProviderConfig, PublicRunRecord, PublicRunSummary, ReasoningEffort, RunEntry, RunLimits, RunRecord,
} from '../../shared/types.ts';

export interface Meta {
  protocols: ProtocolInfo[];
  difficulties: Difficulty[];
  cubeSizes: { n: number; name: string; level: string }[];
  defaultLimits: RunLimits;
  stateEncoding: string;
  reasoningEfforts: { id: ReasoningEffort; name: string }[];
  maxActiveSessions: number;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败（${res.status}）`);
  return data as T;
}

const send = <T>(method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => json<T>(r));

export const api = {
  meta: () => send<Meta>('GET', '/api/meta'),
  refreshModels: (config: ProviderConfig, apiKey: string) => send<ProviderConfig>('POST', '/api/providers/refresh-models', { config, apiKey }),
  testProvider: (config: ProviderConfig, apiKey: string, model: string) => send<ConnectionTestResult>('POST', '/api/providers/test', { config, apiKey, model }),

  startRun: (body: { entries: RunEntry[]; providers: Array<{ config: ProviderConfig; apiKey: string }>; scrambleLength: number; cubeSize: number; limits?: RunLimits }) => send<{ id: string }>('POST', '/api/runs', body),
  runs: () => send<PublicRunSummary[]>('GET', '/api/runs'),
  run: (id: string) => send<PublicRunRecord>('GET', `/api/runs/${id}`),
  report: (id: string) => send<RunRecord>('GET', `/api/runs/${id}/report`),
  stopRun: (id: string) => send<{ ok: true }>('POST', `/api/runs/${id}/stop`),
  runAction: (id: string, action: 'pause' | 'resume' | 'stop') => send<{ ok: true }>('POST', `/api/runs/${id}/${action}`),
  contestantAction: (id: string, cid: string, action: 'pause' | 'resume' | 'stop') =>
    send<{ ok: boolean }>('POST', `/api/runs/${id}/contestants/${cid}/${action}`),
  streamUrl: (id: string) => `/api/runs/${id}/stream`,
  exportUrl: (id: string) => `/api/runs/${id}/export`,
};
