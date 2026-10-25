import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** API Key 的服务端加密存储（AES-256-GCM），主密钥来自环境变量 CREDENTIAL_SECRET */
export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

let cachedKey: Buffer | null = null;

export function encryptionAvailable(): boolean {
  return (process.env.CREDENTIAL_SECRET ?? '').length >= 16;
}

function key(): Buffer {
  if (!encryptionAvailable()) throw new Error('未配置 CREDENTIAL_SECRET（至少 16 个字符），无法加密保存密钥');
  return (cachedKey ??= scryptSync(process.env.CREDENTIAL_SECRET!, 'ai-cube-arena/credentials/v1', 32));
}

export function seal(plain: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function unseal(s: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(s.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
}
