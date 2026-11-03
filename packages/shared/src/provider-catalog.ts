/** One catalog entry as the API, the worker and the provisioner exchange it. */
export interface CatalogModel {
  id: string;
  label: string;
  /** Explicit capability only: absent or false never means "probably yes". */
  supportsTools: boolean;
  contextLength?: number;
}

/**
 * Only an OpenAI-compatible endpoint can be executed by the isolated OpenCode
 * runtime. Other kinds may stay persisted for other adapters, but no task may be
 * created, updated or run against them.
 */
export const EXECUTABLE_PROVIDER_KINDS = ['openai-compatible'] as const;

export function isExecutableProviderKind(kind: string): kind is (typeof EXECUTABLE_PROVIDER_KINDS)[number] {
  return (EXECUTABLE_PROVIDER_KINDS as readonly string[]).includes(kind);
}

function declaredCatalog(value: unknown): Array<Omit<CatalogModel, 'label' | 'supportsTools'> & { label?: string; supportsTools?: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const candidate = entry as { id?: unknown; label?: unknown; supportsTools?: unknown; contextLength?: unknown };
    if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) return [];
    return [{
      id: candidate.id,
      ...(typeof candidate.label === 'string' && candidate.label.length > 0 ? { label: candidate.label } : {}),
      // Absent stays absent: the admin did not declare a capability, so a
      // discovered value must survive. Only an explicit boolean overrides it.
      ...(typeof candidate.supportsTools === 'boolean' ? { supportsTools: candidate.supportsTools } : {}),
      ...(typeof candidate.contextLength === 'number' && Number.isInteger(candidate.contextLength) && candidate.contextLength > 0
        ? { contextLength: candidate.contextLength }
        : {}),
    }];
  });
}

/**
 * The catalog a task may use. The persisted discovery table is the source of the
 * model ids; the admin-declared list is an explicit override for capability and
 * metadata (and covers endpoints that cannot be probed). Declared entries are never
 * silently dropped, and declared values win over discovered ones.
 */
export function mergeProviderCatalog(declared: unknown, discovered: ReadonlyArray<CatalogModel>): CatalogModel[] {
  const declaredById = new Map(declaredCatalog(declared).map((model) => [model.id, model]));
  const merged = discovered.map((model) => {
    const override = declaredById.get(model.id);
    if (!override) return { ...model, supportsTools: model.supportsTools === true };
    declaredById.delete(model.id);
    return {
      id: model.id,
      label: override.label ?? model.label,
      // An omitted flag means "no override", never "force tools off".
      supportsTools: override.supportsTools ?? model.supportsTools === true,
      ...(override.contextLength ?? model.contextLength
        ? { contextLength: override.contextLength ?? model.contextLength }
        : {}),
    };
  });
  for (const model of declaredById.values()) {
    merged.push({
      id: model.id,
      label: model.label ?? model.id,
      supportsTools: model.supportsTools === true,
      ...(model.contextLength ? { contextLength: model.contextLength } : {}),
    });
  }
  return merged;
}

/** Parse a raw `config.models` value without trusting its shape. */
export function configuredCatalog(value: unknown): CatalogModel[] {
  return declaredCatalog(value).map((model) => ({
    id: model.id,
    label: model.label ?? model.id,
    supportsTools: model.supportsTools === true,
    ...(model.contextLength ? { contextLength: model.contextLength } : {}),
  }));
}

/** Resolve a task model (`id` or `id#variant`) against a catalog. */
export function catalogModelFor(catalog: unknown, model: string): CatalogModel | undefined {
  const entries = Array.isArray(catalog) ? (catalog as ReadonlyArray<CatalogModel>) : configuredCatalog(catalog);
  const base = model.split('#')[0];
  return entries.find((entry) => entry?.id === model || entry?.id === base);
}

/**
 * Whether the catalog explicitly declares the model as tool-capable. An unknown
 * model and an undeclared capability are both `false`: the worker must never infer
 * tool support and then silently lose e-mail, research or memory tools.
 */
export function catalogModelSupportsTools(catalog: unknown, model: string): boolean {
  return catalogModelFor(catalog, model)?.supportsTools === true;
}

/** Which task features need model tools in the runtime. Completion e-mail does
 * not: the worker renders and sends it itself, with or without `compose_email`. */
export function taskRequiresTools(input: {
  allowWebResearch: boolean;
  memoryMode: string;
}): boolean {
  return input.allowWebResearch || input.memoryMode !== 'off';
}
