#!/usr/bin/env node
/* eslint-disable no-undef -- standalone Node script run outside the bundler */
// Guard the deliberate divergence between the development compose file and the
// vendored production file:
//
//   * ../compose.yaml                 local/E2E include it; it has build sections
//   * deployment/compose.production.yaml  host snapshot with webnet/static IP,
//                                          absolute support-asset paths, no build
//
// A blanket diff would fail on that intended divergence. This script renders
// both files with the same non-secret example environment and checks the shared
// security-sensitive service invariants plus the production-only contract.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { volumeSignatures, sharedServiceFieldDifferences, sharedVolumeDifferences, sharedNetworkDifferences } from './compose-parity-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = 'deployment/env/production.env.example';
const profileArgs = ['--profile', 'mail', '--profile', 'search', '--profile', 'opencode-runtime'];

function composeConfig(file, extra = [], extraEnv = {}) {
  const args = [
    'compose',
    '--env-file',
    envFile,
    ...profileArgs,
    '-f',
    file,
    ...extra,
    'config',
    '--format',
    'json'
  ];
  try {
    return JSON.parse(
      execFileSync('docker', args, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    );
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    console.error(`compose parity: docker compose config failed for ${file}`);
    console.error(detail);
    process.exit(1);
  }
}

// Root/local Compose fails closed without a provisioner token (the checker never
// starts the fake service, so a non-secret fixture value is enough). Production is
// rendered without it to prove the worker receives no token by default.
const development = composeConfig('compose.yaml', [], {
  OPENCODE_PROVISIONER_TOKEN: 'compose-parity-fixture-token-0123456789'
});
const production = composeConfig('deployment/compose.production.yaml', [
  '--project-directory',
  root
]);

const failures = [];
// The fake runtime is local/E2E-only and stays out of the shared-service
// comparison; the profile-gated real provisioner exists in both files.
const developmentOnlyServices = new Set(['opencode-test-provisioner']);
function check(condition, message) {
  if (!condition) failures.push(message);
}
function stable(value) {
  return JSON.stringify(value ?? null);
}
function sameList(left, right) {
  return stable([...(left ?? [])].sort()) === stable([...(right ?? [])].sort());
}
function securityOpts(service) {
  return (service.security_opt ?? [])
    .map((option) => (option.startsWith('seccomp=') ? 'seccomp=<host-profile>' : option))
    .sort();
}
function networkNames(service) {
  return Object.keys(service?.networks ?? {}).sort();
}

const sharedDevelopmentServices = Object.fromEntries(
  Object.entries(development.services ?? {}).filter(([name]) => !developmentOnlyServices.has(name))
);
check(
  stable(Object.keys(sharedDevelopmentServices).sort()) ===
    stable(Object.keys(production.services ?? {}).sort()),
  'service sets differ between compose.yaml and compose.production.yaml (excluding the documented local fake runtime)'
);
check(production.name === 'agent-tasks', 'production project name must stay agent-tasks');
check(
  production.networks?.backend?.name === 'agent-tasks_backend',
  'production backend network must keep the agent-tasks project prefix'
);
check(
  production.networks?.webnet?.external === true && production.networks?.webnet?.name === 'webnet',
  'production webnet must be declared external with name webnet'
);
check(!development.networks?.webnet, 'compose.yaml must not define the proxy-owned webnet');
for (const name of ['api', 'worker', 'browser-runner']) {
  check(
    development.services?.[name]?.pull_policy === 'build',
    `${name}.pull_policy must be build in compose.yaml so local/E2E uses checkout images`
  );
  check(
    production.services?.[name]?.pull_policy === 'always',
    `${name}.pull_policy must be always in compose.production.yaml so production pulls released images`
  );
}
check(
  stable(Object.keys(production.volumes ?? {}).sort()) ===
    stable(Object.keys(development.volumes ?? {}).sort()),
  'named volume sets differ between compose.yaml and compose.production.yaml'
);
for (const difference of sharedVolumeDifferences(development, production)) {
  check(
    false,
    `volume ${difference} differs from compose.yaml (external/driver/options must match)`
  );
}
for (const difference of sharedNetworkDifferences(development, production)) {
  check(false, `network ${difference} differs from compose.yaml`);
}

const testProvisioner = development.services?.['opencode-test-provisioner'];
check(Boolean(testProvisioner), 'compose.yaml must include the local fake provisioner');
if (testProvisioner) {
  check(
    Object.keys(testProvisioner.networks ?? {}).join(',') === 'opencode-runtime',
    'local fake provisioner must attach only to the internal opencode-runtime network'
  );
  check((testProvisioner.ports ?? []).length === 0, 'local fake provisioner must not publish a host port');
  check((testProvisioner.volumes ?? []).length === 0, 'local fake provisioner must not mount persistent or host data');
  check((testProvisioner.cap_drop ?? []).includes('ALL'), 'local fake provisioner must drop all capabilities');
  check(testProvisioner.read_only === true, 'local fake provisioner must have a read-only root filesystem');
}

// Critical production values must fail closed in the raw file. Rendered config
// cannot prove this because the example supplies values for every key.
const productionSource = readFileSync(resolve(root, 'deployment/compose.production.yaml'), 'utf8');
const requiredProductionVars = [
  'POSTGRES_PASSWORD',
  'PUBLIC_BASE_URL',
  'AUTH_SECRET',
  'SECRETS_ENCRYPTION_KEY',
  'RUNNER_TOKEN',
  'COOKIE_SECURE',
  'TRUST_PROXY'
];
for (const name of requiredProductionVars) {
  check(
    new RegExp(`\\$\\{${name}:\\?`).test(productionSource),
    `compose.production.yaml must fail closed on ${name} (missing \${${name}:?…})`
  );
  check(
    !new RegExp(`\\$\\{${name}:-`).test(productionSource),
    `compose.production.yaml must not provide an insecure fallback for ${name}`
  );
}
// RUNNER_TOKEN belongs to the worker and the browser runner only. The API never
// calls the runner, and a token on api would widen its exposure for no reason.
const productionWorkerToken = production.services?.worker?.environment?.RUNNER_TOKEN;
const productionRunnerToken =
  production.services?.['browser-runner']?.environment?.RUNNER_TOKEN;
check(
  typeof productionWorkerToken === 'string' && productionWorkerToken.length > 0,
  'production worker must receive RUNNER_TOKEN'
);
check(
  productionRunnerToken === productionWorkerToken,
  'production worker and browser-runner must receive the same RUNNER_TOKEN'
);
check(
  production.services?.api?.environment?.RUNNER_TOKEN === undefined,
  'production api must not receive RUNNER_TOKEN'
);
check(
  production.services?.['browser-runner']?.security_opt?.includes(
    'seccomp=/opt/stacks/agent-tasks/docker/seccomp-browser.json'
  ) === true,
  'production browser-runner must default to the deploy-staged seccomp profile'
);
check(
  production.services?.worker?.environment?.OPENCODE_PROVISIONER_TOKEN === '',
  'production worker must receive no provisioner token by default, so it cannot start execution'
);
check(
  production.services?.worker?.environment?.OPENCODE_PROVISIONER_URL === 'http://opencode-provisioner:4090',
  'production worker must target the real isolated provisioner, not the local fake'
);
check(
  !networkNames(production.services?.worker).includes('opencode-egress'),
  'production worker must never join the provider-egress network'
);
const productionProvisioner = production.services?.['opencode-provisioner'];
check(
  productionProvisioner?.profiles?.includes('opencode-runtime') === true,
  'production provisioner must remain profile-gated'
);
check(
  productionProvisioner?.read_only === true && (productionProvisioner?.cap_drop ?? []).includes('ALL'),
  'production provisioner must stay read-only with all capabilities dropped'
);
check(
  (productionProvisioner?.ports ?? []).length === 0,
  'production provisioner must not publish a host port'
);
check(
  (productionProvisioner?.volumes ?? []).some((volume) => volume.source === '/var/run/docker.sock'),
  'production provisioner must be the only service with the Docker socket'
);
check(
  stable(networkNames(productionProvisioner)) === stable(['opencode-egress', 'opencode-runtime']),
  'production provisioner must join the internal runtime network and the egress network only'
);
check(
  stable(networkNames(production.services?.worker)) === stable(['backend', 'opencode-runtime']),
  'production worker must join backend and the internal runtime network only'
);
check(
  production.services?.searxng?.volumes?.some(
    (volume) => volume.source === '/opt/stacks/agent-tasks/docker/searxng/settings.yml'
  ) === true,
  'production SearXNG must default to the host-only settings file'
);

for (const [name, dev] of Object.entries(sharedDevelopmentServices)) {
  const prod = production.services?.[name];
  check(Boolean(prod), `production is missing service ${name}`);
  if (!prod) continue;

  const devComparable = name === 'worker'
    ? comparableWorker(dev, true)
    : name === 'opencode-provisioner' ? comparableProvisioner(dev) : dev;
  const prodComparable = name === 'worker'
    ? comparableWorker(prod, false)
    : name === 'opencode-provisioner' ? comparableProvisioner(prod) : prod;
  for (const field of sharedServiceFieldDifferences(devComparable, prodComparable)) {
    check(
      false,
      `${name}.${field} differs from compose.yaml (production may only differ where documented)`
    );
  }
  check(
    sameList(securityOpts(dev), securityOpts(prod)),
    `${name} security_opt differs from compose.yaml`
  );
  check(
    stable(volumeSignatures(dev, development.name ?? 'agent-tasks', name)) ===
      stable(volumeSignatures(prod, production.name ?? 'agent-tasks', name)),
    `${name} volume sources/targets/modes differ from compose.yaml`
  );
  check(
    prod.labels?.['com.agent-tasks.stack'] === 'production',
    `${name} is missing label com.agent-tasks.stack=production`
  );
  check(
    dev.labels?.['com.centurylinklabs.watchtower.enable'] ===
      prod.labels?.['com.centurylinklabs.watchtower.enable'],
    `${name} watchtower label differs from compose.yaml`
  );

  if (name === 'api') {
    check(
      stable(networkNames(prod)) === stable(['backend', 'webnet']),
      'production api must attach to backend and webnet only'
    );
    check(
      prod.networks?.webnet?.ipv4_address === '172.18.0.70',
      'production api must keep the fixed webnet address 172.18.0.70'
    );
  } else {
    check(
      stable(networkNames(dev)) === stable(networkNames(prod)),
      `${name} networks differ from compose.yaml`
    );
  }
}

function comparableProvisioner(service) {
  const normalized = structuredClone(service);
  normalized.environment ??= {};
  // Both renders share the same example env; only the fixture token injected for
  // the root/local render differs, and neither value is a real secret.
  normalized.environment.OPENCODE_PROVISIONER_TOKEN = '<provisioner-token>';
  return normalized;
}

function comparableWorker(service, local) {
  const normalized = structuredClone(service);
  normalized.environment ??= {};
  normalized.environment.OPENCODE_PROVISIONER_URL = '<internal-provisioner>';
  normalized.environment.OPENCODE_PROVISIONER_TOKEN = '<provisioner-token>';
  if (local) delete normalized.depends_on?.['opencode-test-provisioner'];
  if (!local) delete normalized.profiles;
  return normalized;
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`compose parity: ${failure}`);
  process.exit(1);
}

console.log(
  `compose parity: OK (${Object.keys(production.services).length} services, security fields, volume sources and volume/network attributes shared, RUNNER_TOKEN only on worker/browser-runner, production labels and webnet contract intact)`
);
