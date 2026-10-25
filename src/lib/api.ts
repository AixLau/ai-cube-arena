import type {
  ConnectionTestResult, Difficulty, ProtocolInfo, ProviderConfig, ProviderDraft, ReasoningEffort, RunEntry, RunLimits, RunRecord,
  RunSummary,
} from '../../shared/types.ts';

export interface Meta {
  protocols: ProtocolInfo[];
  difficulties: Difficulty[];
  cubeSizes: { n: number; name: string; level: string }[];
  defaultLimits: RunLimits;
  encryptionAvailable: boolean;
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
  providers: () => send<ProviderConfig[]>('GET', '/api/providers'),
  createProvider: (d: ProviderDraft) => send<ProviderConfig>('POST', '/api/providers', d),
  updateProvider: (id: string, d: ProviderDraft) => send<ProviderConfig>('PUT', `/api/providers/${id}`, d),
  duplicateProvider: (id: string) => send<ProviderConfig>('POST', `/api/providers/${id}/duplicate`),
  deleteProvider: (id: string) => send<{ ok: true }>('DELETE', `/api/providers/${id}`),
  refreshModels: (id: string) => send<ProviderConfig>('POST', `/api/providers/${id}/refresh-models`),
  testProvider: (id: string, model: string) => send<ConnectionTestResult>('POST', `/api/providers/${id}/test`, { model }),

  startRun: (body: { entries: RunEntry[]; difficulty: string; cubeSize: number; limits: RunLimits }) => send<{ id: string }>('POST', '/api/runs', body),
  runs: () => send<RunSummary[]>('GET', '/api/runs'),
  run: (id: string) => send<RunRecord>('GET', `/api/runs/${id}`),
  stopRun: (id: string) => send<{ ok: true }>('POST', `/api/runs/${id}/stop`),
  contestantAction: (id: string, cid: string, action: 'pause' | 'resume' | 'stop') =>
    send<{ ok: boolean }>('POST', `/api/runs/${id}/contestants/${cid}/${action}`),
  streamUrl: (id: string) => `/api/runs/${id}/stream`,
  exportUrl: (id: string) => `/api/runs/${id}/export`,
};
