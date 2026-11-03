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

/**
 * The model a new task should start on: the admin-selected default when it is
 * still in the catalog, otherwise the first offered model. The task form keeps
 * the choice as an ordinary value, so changing the default never rewrites an
 * existing task.
 */
export function preferredModelId(provider: {
  defaultModel?: string;
  models: Array<{ id: string }>;
}): string {
  if (provider.defaultModel && provider.models.some((model) => model.id === provider.defaultModel)) {
    return provider.defaultModel;
  }
  return provider.models[0]?.id ?? '';
}

/** Hidden models stay in the admin catalog but are not offered in the task editor. */
export function disabledModelIds(config: Record<string, unknown>): string[] {
  const value = config.disabledModels;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}
