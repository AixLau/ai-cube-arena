/** 从任意文本中抹除 API Key：先替换已知密钥原文，再兜底匹配常见密钥格式 */
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_\-]{8,}/g,
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,
  /AIza[0-9A-Za-z_\-]{20,}/g,
  // 供应商自行打码后回显的密钥尾号，例如 ****5678
  /\*{3,}[A-Za-z0-9_\-]{2,8}/g,
  /(Bearer\s+)[A-Za-z0-9._\-~+/=]{8,}/gi,
  /((?:api[_-]?key|x-api-key|x-goog-api-key|authorization|key)["'\s:=]+)[A-Za-z0-9._\-~+/=]{12,}/gi,
];

export function redact(text: string, secrets: (string | undefined | null)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('[已隐藏]');
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (_m, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[已隐藏]` : '[已隐藏]'));
  }
  return out;
}
