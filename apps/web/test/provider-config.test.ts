import { describe, expect, it } from 'vitest';
import {
  REDACTED_HEADER_VALUE,
  buildProviderUpdateConfig,
  disabledModelIds,
  preferredModelId,
  providerBaseUrl,
  providerConfigNeedsUpdate,
  providerHeaderNames,
} from '../src/lib/provider-config';

describe('provider config editing', () => {
  const original = {
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'model-a', supportsTools: true }],
    headers: { Authorization: REDACTED_HEADER_VALUE, 'X-Tenant': REDACTED_HEADER_VALUE },
  };

  it('keeps header names for display', () => {
    expect(providerHeaderNames(original)).toEqual(['Authorization', 'X-Tenant']);
  });

  it('never invents a header value and keeps the redaction sentinel', () => {
    // The admin API restores stored values for `***`; the web only ever forwards
    // the sentinel it received, so real secrets never enter the browser.
    const config = buildProviderUpdateConfig(original, 'https://api.example.com/v2');
    expect(config.baseUrl).toBe('https://api.example.com/v2');
    expect(config.headers).toEqual({ Authorization: REDACTED_HEADER_VALUE, 'X-Tenant': REDACTED_HEADER_VALUE });
    expect(config.models).toEqual([{ id: 'model-a', supportsTools: true }]);
  });

  it('omits the config payload when the editable field did not change', () => {
    expect(providerConfigNeedsUpdate(original, 'https://api.example.com/v1')).toBe(false);
    expect(providerConfigNeedsUpdate(original, 'https://api.example.com/v2')).toBe(true);
  });

  it('normalises an empty base URL to the Ollama default', () => {
    expect(buildProviderUpdateConfig({}, '   ').baseUrl).toBe('http://ollama:11434');
    expect(providerBaseUrl({})).toBe('');
  });

  it('preselects the admin default model and falls back to the first offered one', () => {
    const models = [{ id: 'model-a' }, { id: 'model-b' }];
    expect(preferredModelId({ defaultModel: 'model-b', models })).toBe('model-b');
    expect(preferredModelId({ models })).toBe('model-a');
    // A stale default (removed from the catalog) must not produce an invalid task.
    expect(preferredModelId({ defaultModel: 'gone', models })).toBe('model-a');
    expect(preferredModelId({ models: [] })).toBe('');
  });

  it('reads hidden models defensively', () => {
    expect(disabledModelIds({ disabledModels: ['model-b', 3] })).toEqual(['model-b']);
    expect(disabledModelIds({})).toEqual([]);
  });
});
