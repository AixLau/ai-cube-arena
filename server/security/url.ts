import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

/**
 * 自定义供应商地址的 SSRF 防护：
 * 1. 仅允许 https（ALLOW_HTTP_PROVIDERS=true 时放开 http）；禁止 URL 内嵌凭据；
 * 2. 拒绝内网、回环、链路本地（含云元数据 169.254.169.254）、CGNAT、组播、保留地址及其 IPv6 对应段；
 * 3. 域名在「实际建立连接时」解析并校验全部解析结果（见 safeDispatcher），防止 DNS 重绑定；
 * 4. 请求一律不跟随重定向（由调用方以 redirect: 'manual' 拒绝 3xx）。
 * 本地开发如需接入本机模型服务，可设置 ALLOW_PRIVATE_PROVIDER_HOSTS=true。
 */

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(addr, prefix, 'ipv6');

const BLOCKED_HOST_SUFFIXES = ['localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];

const allowPrivate = () => process.env.ALLOW_PRIVATE_PROVIDER_HOSTS === 'true';
const allowHttp = () => process.env.ALLOW_HTTP_PROVIDERS === 'true';

export class UrlPolicyError extends Error {}

/** IPv6 中内嵌 IPv4 的形式（::ffff:a.b.c.d、64:ff9b::/96、6to4）按内嵌的 IPv4 判断 */
function embeddedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1];
  const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1], 16);
    const lo = parseInt(sixToFour[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIPv4(ip);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true;
}

/** 同步校验 URL 结构与字面量地址；域名的解析结果在连接时校验 */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlPolicyError('API 地址格式不正确');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp())) {
    throw new UrlPolicyError('仅支持 HTTPS 接口地址');
  }
  if (url.username || url.password) throw new UrlPolicyError('API 地址中不能包含用户名或密码');
  if (allowPrivate()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new UrlPolicyError('不允许访问内网、回环或保留地址');
    return url;
  }
  if (!host.includes('.') || BLOCKED_HOST_SUFFIXES.some((s) => host === s.replace(/^\./, '') || host.endsWith(s))) {
    throw new UrlPolicyError('不允许访问内网主机名');
  }
  if (host === 'metadata.google.internal' || host.startsWith('metadata.')) {
    throw new UrlPolicyError('不允许访问云服务元数据地址');
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** 连接时解析域名，任一解析结果命中黑名单即拒绝，并把连接固定到已校验的地址 */
export function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as dns.LookupAddress[];
    if (!allowPrivate()) {
      const bad = list.find((a) => isBlockedIp(a.address));
      if (bad) {
        const e = new Error('解析到内网或保留地址，已拒绝连接') as NodeJS.ErrnoException;
        e.code = 'EBLOCKEDADDR';
        return callback(e, []);
      }
    }
    if (!list.length) return callback(new Error('域名无解析结果') as NodeJS.ErrnoException, []);
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export const safeDispatcher = new Agent({
  connect: { lookup: safeLookup as unknown as net.LookupFunction },
  headersTimeout: 180_000,
  bodyTimeout: 180_000,
});
