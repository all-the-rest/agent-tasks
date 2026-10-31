import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — used to finish a real MFA flow in tests. */
export function totp(secret: string, timestampMs: number = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(timestampMs / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    ((digest[offset] ?? 0) & 0x7f) * 2 ** 24 +
    ((digest[offset + 1] ?? 0) << 16) +
    ((digest[offset + 2] ?? 0) << 8) +
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function secretFromTotpUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('totp uri without secret');
  return secret;
}
