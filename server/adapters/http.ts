import { fetch } from 'undici';
import type { AuthMode } from '../../shared/types.ts';
import { redact } from '../security/redact.ts';
import { assertAllowedUrl, safeDispatcher, UrlPolicyError } from '../security/url.ts';

export type ProviderErrorKind = 'url' | 'network' | 'timeout' | 'aborted' | 'redirect' | 'http' | 'parse' | 'api';

/** 发往前端的错误：message/detail 均已脱敏 */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly detail = '',
    /** 供应商通过 Retry-After 建议的等待时间 */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.max(0, Math.min(sec * 1000, 120_000));
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 120_000)) : null;
}

const MAX_BODY = 8 * 1024 * 1024;

export function authHeaders(mode: AuthMode, key: string | undefined): Record<string, string> {
  if (!key || mode === 'none') return {};
  if (mode === 'x-api-key') return { 'x-api-key': key };
  if (mode === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return { Authorization: `Bearer ${key}` };
}

/** 从各家错误响应中提取说明文字 */
export function upstreamMessage(json: unknown, text: string): string {
  const j = json as Record<string, any> | null;
  const msg =
    (typeof j?.error === 'string' && j.error) ||
    j?.error?.message ||
    j?.message ||
    j?.msg ||
    j?.detail ||
    (Array.isArray(j) && j[0]?.error?.message) ||
    text;
  return String(msg ?? '').replace(/\s+/g, ' ').slice(0, 400);
}

interface PostOptions {
  signal: AbortSignal;
  timeoutMs: number | null;
  secrets: (string | undefined)[];
}

export function postJson(url: string, headers: Record<string, string>, body: unknown, opts: PostOptions) {
  return requestJson('POST', url, headers, body, opts);
}

export function getJson(url: string, headers: Record<string, string>, opts: PostOptions) {
  return requestJson('GET', url, headers, undefined, opts);
}

async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body: unknown,
  { signal, timeoutMs, secrets }: PostOptions,
): Promise<{ status: number; json: any; latencyMs: number }> {
  try {
    assertAllowedUrl(url);
  } catch (e) {
    throw new ProviderError('url', e instanceof UrlPolicyError ? e.message : 'API 地址无效');
  }
  const timeout = timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Accept: 'application/json', ...headers, 'User-Agent': 'codex-tui/0.157.1 (Mac OS 26.6.2; arm64) ghostty/1.3.1 (codex-tui; 0.157.1)' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: timeout ? AbortSignal.any([signal, timeout]) : signal,
      dispatcher: safeDispatcher,
    });
  } catch (e) {
    if (signal.aborted) throw new ProviderError('aborted', '请求已取消');
    if (timeout?.aborted) throw new ProviderError('timeout', `请求超时（${Math.round(timeoutMs! / 1000)} 秒）`);
    const cause = (e as { cause?: NodeJS.ErrnoException }).cause;
    const code = cause?.code ?? '';
    const map: Record<string, string> = {
      EBLOCKEDADDR: '目标域名解析到内网或保留地址，已拒绝连接',
      ENOTFOUND: '域名无法解析，请检查 API 地址',
      ECONNREFUSED: '连接被拒绝',
      ECONNRESET: '连接被重置',
      ETIMEDOUT: '连接超时',
      CERT_HAS_EXPIRED: 'TLS 证书已过期',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书校验失败',
      DEPTH_ZERO_SELF_SIGNED_CERT: '对方使用自签名证书，已拒绝',
      ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书与域名不匹配',
    };
    throw new ProviderError('network', map[code] ?? `网络错误${code ? `（${code}）` : ''}`, null, redact(cause?.message ?? '', secrets));
  }

  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError('redirect', `接口返回重定向（HTTP ${res.status}），出于安全考虑不跟随，请直接填写最终地址`, res.status);
  }

  // 读取响应体并限制大小
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read().catch((e) => {
        if (timeout?.aborted) throw new ProviderError('timeout', `请求超时（${Math.round(timeoutMs! / 1000)} 秒）`);
        if (signal.aborted) throw new ProviderError('aborted', '请求已取消');
        throw new ProviderError('network', '读取响应失败', res.status, redact(String(e?.message ?? ''), secrets));
      });
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {});
        throw new ProviderError('parse', '响应体过大，已中止', res.status);
      }
      chunks.push(value);
    }
  }
  const latencyMs = Date.now() - started;
  const text = Buffer.concat(chunks).toString('utf8');
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }

  if (res.status >= 400) {
    throw new ProviderError(
      'http',
      `HTTP ${res.status}：${redact(upstreamMessage(json, text), secrets) || '无错误说明'}`,
      res.status,
      redact(text.slice(0, 800), secrets),
      parseRetryAfter(res.headers.get('retry-after')),
    );
  }
  if (json === null) {
    const hint = /^\s*</.test(text) ? '（返回了 HTML 页面，Base URL 可能指向网站首页而非 API）' : '';
    throw new ProviderError('parse', `响应不是 JSON${hint}`, res.status, redact(text.slice(0, 300), secrets));
  }
  // 部分中转站在 HTTP 200 中返回错误
  if (json && typeof json === 'object' && json.error && !json.choices && !json.output && !json.content && !json.candidates) {
    throw new ProviderError('api', `接口错误：${redact(upstreamMessage(json, text), secrets)}`, res.status, redact(text.slice(0, 800), secrets));
  }
  return { status: res.status, json, latencyMs };
}
