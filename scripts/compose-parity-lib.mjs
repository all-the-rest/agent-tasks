// Pure helpers for scripts/check-compose-parity.mjs. Kept separate so
// scripts/test-compose-parity.mjs can exercise the volume comparison without a
// Docker daemon.

// Bind mounts whose absolute source deliberately differs between the local file
// (repository-relative) and the production host snapshot (/opt/stacks/...).
// Only a source with the documented repository suffix is accepted; it is then
// compared by its shared logical asset instead of the host path. The production
// absolute path itself is checked in check-compose-parity.mjs.
const DOCUMENTED_BIND_TARGETS = new Map([
  [
    'searxng:/etc/searxng/settings.yml',
    { suffix: '/docker/searxng/settings.yml', logical: 'host:searxng-settings' }
  ]
]);

function volumeSource(volume, projectName, serviceName) {
  const type = String(volume.type ?? '');
  const source = String(volume.source ?? '');
  if (type === 'volume') {
    // Rendered named volumes carry the project prefix; compare the declared
    // logical volume name so different project names cannot mask a mismatch.
    const prefix = `${projectName}_`;
    return source.startsWith(prefix) ? source.slice(prefix.length) : source;
  }
  if (type === 'bind') {
    const documented = DOCUMENTED_BIND_TARGETS.get(`${serviceName}:${volume.target}`);
    if (documented && source.endsWith(documented.suffix)) return documented.logical;
    return `bind:${source}`;
  }
  return `${type}:${source}`;
}
// A volume signature covers type, source, target and read-only mode. Two
// services that disagree on the source (for example a different named volume)
// must fail the parity check even when the target is identical.
export function volumeSignatures(service, projectName, serviceName) {
  return (service.volumes ?? [])
    .map((volume) =>
      [
        String(volume.type ?? ''),
        volumeSource(volume, projectName, serviceName),
        String(volume.target ?? ''),
        volume.read_only ? 'ro' : 'rw'
      ].join(':')
    )
    .sort();
}

// Service fields whose production value must match the local file. This list is
// shared with scripts/test-compose-parity.mjs so a field cannot be added to the
// CI comparison without an offline mismatch test.
export const SHARED_SERVICE_FIELDS = [
  'image',
  'pull_policy',
  'restart',
  'read_only',
  'cap_drop',
  'cap_add',
  'pids_limit',
  'mem_limit',
  'cpus',
  'tmpfs',
  'healthcheck',
  'command',
  'entrypoint',
  'depends_on',
  'ports',
  'profiles',
  'environment',
  'stop_grace_period',
  'privileged',
  'user',
  'network_mode',
  'devices',
  'sysctls',
  'ulimits'
];

export function sharedServiceFieldDifferences(development, production, fields = SHARED_SERVICE_FIELDS) {
  return fields.filter(
    (field) =>
      JSON.stringify(development?.[field] ?? null) !==
      JSON.stringify(production?.[field] ?? null)
  );
}

// Top-level named-volume attributes. The rendered `name` carries the project
// prefix, so a coordinated project rename cannot hide a different backing volume.
export const SHARED_VOLUME_FIELDS = ['name', 'external', 'driver', 'driver_opts'];

export function sharedVolumeDifferences(
  development,
  production,
  fields = SHARED_VOLUME_FIELDS
) {
  const names = new Set([
    ...Object.keys(development?.volumes ?? {}),
    ...Object.keys(production?.volumes ?? {})
  ]);
  const differences = [];
  for (const name of [...names].sort()) {
    const left = development?.volumes?.[name] ?? {};
    const right = production?.volumes?.[name] ?? {};
    for (const field of fields) {
      if (JSON.stringify(left[field] ?? null) !== JSON.stringify(right[field] ?? null)) {
        differences.push(`${name}.${field}`);
      }
    }
  }
  return differences;
}

// Network properties that must not silently diverge. `internal: true` isolates a
// network from the host and from egress, so flipping it in one file changes the
// security model.
export const SHARED_NETWORK_FIELDS = ['internal'];

export function sharedNetworkDifferences(
  development,
  production,
  fields = SHARED_NETWORK_FIELDS
) {
  const differences = [];
  for (const name of Object.keys(development?.networks ?? {}).sort()) {
    if (!Object.hasOwn(production?.networks ?? {}, name)) continue;
    const left = development.networks[name] ?? {};
    const right = production.networks[name] ?? {};
    for (const field of fields) {
      if (JSON.stringify(left[field] ?? null) !== JSON.stringify(right[field] ?? null)) {
        differences.push(`${name}.${field}`);
      }
    }
  }
  return differences;
}
