#!/usr/bin/env node
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
const profileArgs = ['--profile', 'mail', '--profile', 'search'];

function composeConfig(file, extra = []) {
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

const development = composeConfig('compose.yaml');
const production = composeConfig('deployment/compose.production.yaml', [
  '--project-directory',
  root
]);

const failures = [];
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
  return Object.keys(service.networks ?? {}).sort();
}

check(
  stable(Object.keys(development.services ?? {}).sort()) ===
    stable(Object.keys(production.services ?? {}).sort()),
  'service sets differ between compose.yaml and compose.production.yaml'
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
  production.services?.searxng?.volumes?.some(
    (volume) => volume.source === '/opt/stacks/agent-tasks/docker/searxng/settings.yml'
  ) === true,
  'production SearXNG must default to the host-only settings file'
);

for (const [name, dev] of Object.entries(development.services ?? {})) {
  const prod = production.services?.[name];
  check(Boolean(prod), `production is missing service ${name}`);
  if (!prod) continue;

  for (const field of sharedServiceFieldDifferences(dev, prod)) {
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

if (failures.length > 0) {
  for (const failure of failures) console.error(`compose parity: ${failure}`);
  process.exit(1);
}

console.log(
  `compose parity: OK (${Object.keys(production.services).length} services, security fields, volume sources and volume/network attributes shared, RUNNER_TOKEN only on worker/browser-runner, production labels and webnet contract intact)`
);
