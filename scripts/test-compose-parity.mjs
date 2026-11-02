#!/usr/bin/env node
// Offline tests for the volume comparison used by check-compose-parity.mjs.
// The CI parity check needs a Docker daemon; this file proves that the
// comparison itself rejects a mismatched named volume source, a mode change and
// an undocumented bind path, while accepting the documented SearXNG host path.
import { strict as assert } from 'node:assert';
import {
  volumeSignatures,
  sharedServiceFieldDifferences,
  sharedVolumeDifferences,
  sharedNetworkDifferences
} from './compose-parity-lib.mjs';

const project = 'agent-tasks';

function signatures(service, serviceName = 'postgres') {
  return volumeSignatures(service, project, serviceName);
}

const localNamedVolume = {
  volumes: [
    {
      type: 'volume',
      source: `${project}_postgres-data`,
      target: '/var/lib/postgresql/data'
    }
  ]
};
const hostNamedVolume = {
  volumes: [
    {
      type: 'volume',
      source: `${project}_postgres-data`,
      target: '/var/lib/postgresql/data',
      read_only: false
    }
  ]
};

assert.deepEqual(
  signatures(localNamedVolume),
  signatures(hostNamedVolume),
  'the same named volume and target must compare equal'
);

const otherVolume = {
  volumes: [
    {
      type: 'volume',
      source: `${project}_codex-homes`,
      target: '/var/lib/postgresql/data'
    }
  ]
};
assert.notDeepEqual(
  signatures(otherVolume),
  signatures(localNamedVolume),
  'a different named volume source with the same target must fail'
);

const readOnlyVolume = {
  volumes: [
    {
      type: 'volume',
      source: `${project}_postgres-data`,
      target: '/var/lib/postgresql/data',
      read_only: true
    }
  ]
};
assert.notDeepEqual(
  signatures(readOnlyVolume),
  signatures(localNamedVolume),
  'a named volume mode change must fail'
);

const localSearxng = {
  volumes: [
    {
      type: 'bind',
      source: '/checkout/docker/searxng/settings.yml',
      target: '/etc/searxng/settings.yml',
      read_only: true
    }
  ]
};
const hostSearxng = {
  volumes: [
    {
      type: 'bind',
      source: '/opt/stacks/agent-tasks/docker/searxng/settings.yml',
      target: '/etc/searxng/settings.yml',
      read_only: true
    }
  ]
};
assert.deepEqual(
  signatures(localSearxng, 'searxng'),
  signatures(hostSearxng, 'searxng'),
  'the documented SearXNG settings bind must compare by logical asset'
);

const unexpectedBind = {
  volumes: [
    {
      type: 'bind',
      source: '/srv/other/settings.yml',
      target: '/etc/elsewhere/settings.yml',
      read_only: true
    }
  ]
};
assert.notDeepEqual(
  signatures(unexpectedBind, 'searxng'),
  signatures(hostSearxng, 'searxng'),
  'an undocumented bind path must not be normalised away'
);

const wrongSearxngSource = {
  volumes: [
    {
      type: 'bind',
      source: '/opt/stacks/agent-tasks/docker/searxng/other.yml',
      target: '/etc/searxng/settings.yml',
      read_only: true
    }
  ]
};
assert.notDeepEqual(
  signatures(wrongSearxngSource, 'searxng'),
  signatures(hostSearxng, 'searxng'),
  'the documented allowance must not hide a different source file'
);

// The shared service-field comparison includes privileged/user/network_mode/
// devices/sysctls/ulimits. Each representative divergence must fail.
const securityBase = {
  privileged: false,
  user: '1000:1000',
  network_mode: 'bridge',
  devices: [],
  sysctls: {},
  ulimits: { nofile: { soft: 1024, hard: 2048 } }
};

assert.deepEqual(
  sharedServiceFieldDifferences(
    securityBase,
    JSON.parse(JSON.stringify(securityBase))
  ),
  [],
  'identical security fields must compare equal'
);

for (const [field, value] of [
  ['privileged', true],
  ['user', '0:0'],
  ['network_mode', 'host'],
  ['devices', [{ source: '/dev/null', target: '/dev/null' }]],
  ['sysctls', { 'net.ipv4.ip_forward': '1' }],
  ['ulimits', { nofile: { soft: 1, hard: 2 } }]
]) {
  const mutated = JSON.parse(JSON.stringify(securityBase));
  mutated[field] = value;
  assert.deepEqual(
    sharedServiceFieldDifferences(securityBase, mutated),
    [field],
    `${field} divergence must fail the parity comparison`
  );
}

// Top-level volume attributes: external, driver and driver options must match.
const volumeBase = {
  volumes: {
    'postgres-data': {
      name: 'agent-tasks_postgres-data',
      external: false,
      driver: 'local',
      driver_opts: {}
    }
  }
};

assert.deepEqual(
  sharedVolumeDifferences(volumeBase, JSON.parse(JSON.stringify(volumeBase))),
  [],
  'identical named volume attributes must compare equal'
);

for (const [field, value] of [
  ['external', true],
  ['driver', 'other-driver'],
  ['driver_opts', { type: 'nfs' }]
]) {
  const mutated = JSON.parse(JSON.stringify(volumeBase));
  mutated.volumes['postgres-data'][field] = value;
  assert.deepEqual(
    sharedVolumeDifferences(volumeBase, mutated),
    [`postgres-data.${field}`],
    `volume ${field} divergence must fail the parity comparison`
  );
}

// backend.internal changes the isolation model and must match.
const networkBase = { networks: { backend: { internal: false } } };
assert.deepEqual(
  sharedNetworkDifferences(
    networkBase,
    JSON.parse(JSON.stringify(networkBase))
  ),
  [],
  'identical network properties must compare equal'
);
const isolatedBackend = { networks: { backend: { internal: true } } };
assert.deepEqual(
  sharedNetworkDifferences(networkBase, isolatedBackend),
  ['backend.internal'],
  'backend.internal divergence must fail the parity comparison'
);

console.log(
  'compose parity lib: OK (named volume source/mode mismatches rejected, documented SearXNG bind allowed, undocumented binds compared by source, privileged/user/network_mode/devices/sysctls/ulimits, volume external/driver/options and backend.internal mismatches rejected)'
);
