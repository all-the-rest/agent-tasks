/** The placeholder the admin API uses instead of returning a stored header value. */
export const REDACTED_HEADER_VALUE = '***';

const DEFAULT_OLLAMA_BASE_URL = 'http://ollama:11434';

function headerEntries(config: Record<string, unknown>): Array<[string, unknown]> {
  const headers = config.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return [];
  return Object.entries(headers);
}

/** Header names are safe to show; their values are write-only. */
export function providerHeaderNames(config: Record<string, unknown>): string[] {
  return headerEntries(config).map(([name]) => name);
}

/** The base URL the API returned, which is also the value the dialog starts with. */
export function providerBaseUrl(config: Record<string, unknown>): string {
  return typeof config.baseUrl === 'string' ? config.baseUrl : '';
}

/**
 * Build the PATCH config for the edit dialog.
 *
 * The admin GET replaces every header value with `***`; the API treats that
 * placeholder as "unchanged" and restores the stored value. The web therefore
 * keeps the placeholder instead of inventing a value — it never sends a real
 * secret, and it never asks the API to store literal asterisks.
 */
export function buildProviderUpdateConfig(
  original: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  const config = { ...original };
  const headers = headerEntries(config);
  if (headers.length > 0) {
    config.headers = Object.fromEntries(
      headers.map(([name, value]) => [name, value === REDACTED_HEADER_VALUE ? REDACTED_HEADER_VALUE : value]),
    );
  }
  config.baseUrl = baseUrl.trim() || DEFAULT_OLLAMA_BASE_URL;
  return config;
}

/**
 * Only `baseUrl` is editable in the dialog. When it did not change the PATCH can
 * omit `config` entirely, so stored headers never leave the server in a request.
 */
export function providerConfigNeedsUpdate(config: Record<string, unknown>, baseUrl: string): boolean {
  return providerBaseUrl(config) !== (baseUrl.trim() || DEFAULT_OLLAMA_BASE_URL);
}
