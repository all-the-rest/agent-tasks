import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Provider secrets at rest. Key comes from `SECRETS_ENCRYPTION_KEY` (base64, 32 bytes).
 * Rotation: keep the old key in `SECRETS_ENCRYPTION_KEY_PREVIOUS` while every row is
 * re-encrypted with the new key, then drop the old one (documented in SECURITY.md).
 */
const ALGORITHM = 'aes-256-gcm';

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes of base64`);
  return key;
}

export class SecretBox {
  private readonly current: Buffer;
  private readonly previous: Buffer | null;

  constructor(currentKey: string, previousKey?: string) {
    this.current = decodeKey(currentKey, 'SECRETS_ENCRYPTION_KEY');
    this.previous = previousKey ? decodeKey(previousKey, 'SECRETS_ENCRYPTION_KEY_PREVIOUS') : null;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.current, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('malformed ciphertext');
    const [, iv, tag, data] = parts as [string, string, string, string];
    const attempt = (key: Buffer): string => {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    };
    try {
      return attempt(this.current);
    } catch (error) {
      if (this.previous) return attempt(this.previous);
      throw error;
    }
  }
}

/** Redacts secrets from free-form text before it is stored, logged or returned. */
export function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    result = result.split(secret).join('[redacted]');
  }
  return result
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted]')
    .replace(/\b(ghp_[A-Za-z0-9]{20,})\b/g, '[redacted]')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[redacted]');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
