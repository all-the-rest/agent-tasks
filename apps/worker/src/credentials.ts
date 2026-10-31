export interface CredentialRow {
  ownerId: string | null;
  ciphertext: string;
}

/**
 * Every secret that may appear in an error message for this provider: the credential
 * resolved for the run plus every other credential stored on the same provider (a failed
 * personal credential can echo the shared key or vice versa). Decryption failures are
 * skipped silently — a rotated or foreign ciphertext is unusable, and its content must
 * never reach a log.
 */
export function collectKnownSecrets(
  resolvedApiKey: string | undefined,
  rows: CredentialRow[],
  decrypt: (ciphertext: string) => string,
): string[] {
  const secrets = new Set<string>();
  if (resolvedApiKey) secrets.add(resolvedApiKey);
  for (const row of rows) {
    try {
      const value = decrypt(row.ciphertext);
      if (value) secrets.add(value);
    } catch {
      // Skip undecryptable rows; do not log the ciphertext or the error.
    }
  }
  return [...secrets];
}
