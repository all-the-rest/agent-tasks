import { describe, expect, it } from 'vitest';
import {
  catalogModelFor,
  catalogModelSupportsTools,
  configuredCatalog,
  isExecutableProviderKind,
  mergeProviderCatalog,
  taskRequiresTools,
} from '../src/provider-catalog.js';

const discovered = [
  { id: 'model-a', label: 'Model A', supportsTools: false, contextLength: 32_000 },
  { id: 'model-b', label: 'Model B', supportsTools: true },
];

describe('provider catalog', () => {
  it('uses the persisted discovery catalog and lets declared metadata override it', () => {
    const merged = mergeProviderCatalog(
      [
        { id: 'model-a', supportsTools: true, contextLength: 64_000 },
        { id: 'declared-only', label: 'Declared only', supportsTools: true },
      ],
      discovered,
    );
    expect(merged).toEqual([
      { id: 'model-a', label: 'Model A', supportsTools: true, contextLength: 64_000 },
      { id: 'model-b', label: 'Model B', supportsTools: true },
      { id: 'declared-only', label: 'Declared only', supportsTools: true },
    ]);
  });

  it('never treats an inferred or absent capability as tool support', () => {
    const catalog = mergeProviderCatalog([{ id: 'model-a' }], discovered);
    expect(catalogModelSupportsTools(catalog, 'model-a')).toBe(false);
    expect(catalogModelSupportsTools(catalog, 'model-b')).toBe(true);
    expect(catalogModelSupportsTools(catalog, 'unknown-model')).toBe(false);
    expect(catalogModelSupportsTools(undefined, 'model-b')).toBe(false);
  });

  it('resolves a model selection with its reasoning variant to the base catalog entry', () => {
    expect(catalogModelFor(discovered, 'model-b#high')?.id).toBe('model-b');
    expect(catalogModelFor(discovered, 'model-b#high')?.supportsTools).toBe(true);
  });

  it('reads a raw config.models value defensively', () => {
    expect(configuredCatalog([
      { id: 'model-a', supportsTools: true, contextLength: 1_000 },
      { id: 'model-b' },
      { id: 3 },
      null,
      'model-c',
      { id: 'model-d', supportsTools: 'yes' },
    ])).toEqual([
      { id: 'model-a', label: 'model-a', supportsTools: true, contextLength: 1_000 },
      { id: 'model-b', label: 'model-b', supportsTools: false },
      { id: 'model-d', label: 'model-d', supportsTools: false },
    ]);
  });

  it('allows only OpenAI-compatible provider kinds to execute tasks', () => {
    expect(isExecutableProviderKind('openai-compatible')).toBe(true);
    for (const kind of ['openai', 'ollama', 'codex', 'unknown']) {
      expect(isExecutableProviderKind(kind)).toBe(false);
    }
  });

  it('keeps a discovered capability when a declared override omits the flag', () => {
    const merged = mergeProviderCatalog([{ id: 'model-b', label: 'Renamed' }], discovered);
    expect(merged.find((model) => model.id === 'model-b')).toEqual({ id: 'model-b', label: 'Renamed', supportsTools: true });
    const explicitOff = mergeProviderCatalog([{ id: 'model-b', supportsTools: false }], discovered);
    expect(explicitOff.find((model) => model.id === 'model-b')?.supportsTools).toBe(false);
  });

  it('requires model tools for research or any memory mode except off', () => {
    expect(taskRequiresTools({ allowWebResearch: true, memoryMode: 'off' })).toBe(true);
    expect(taskRequiresTools({ allowWebResearch: false, memoryMode: 'auto' })).toBe(true);
    expect(taskRequiresTools({ allowWebResearch: false, memoryMode: 'suggest' })).toBe(true);
    expect(taskRequiresTools({ allowWebResearch: false, memoryMode: 'off' })).toBe(false);
  });
});
