import { describe, expect, it } from 'vitest';
import { SecretBox } from '@agent-tasks/ai-providers';
import { collectKnownSecrets } from '../src/credentials.js';

const box = new SecretBox(Buffer.alloc(32, 9).toString('base64'));
const decrypt = (ciphertext: string): string => box.decrypt(ciphertext);

describe('secret redaction coverage', () => {
  it('collects the resolved key and every other credential of the provider', () => {
    const sharedKey = 'shared-provider-key-123';
    const personalKey = 'personal-provider-key-456';
    const secrets = collectKnownSecrets(
      personalKey,
      [
        { ownerId: null, ciphertext: box.encrypt(sharedKey) },
        { ownerId: 'owner-id', ciphertext: box.encrypt(personalKey) },
      ],
      decrypt,
    );
    expect(secrets.sort()).toEqual([personalKey, sharedKey].sort());
    expect(secrets).toHaveLength(2);
  });

  it('skips credentials that cannot be decrypted without throwing', () => {
    const liveKey = 'live-provider-key-789';
    const secrets = collectKnownSecrets(
      'resolved-key',
      [
        { ownerId: null, ciphertext: box.encrypt(liveKey) },
        { ownerId: 'rotated', ciphertext: 'v1.bm90.a.bm90' },
      ],
      decrypt,
    );
    expect(secrets.sort()).toEqual(['live-provider-key-789', 'resolved-key'].sort());
  });
});
