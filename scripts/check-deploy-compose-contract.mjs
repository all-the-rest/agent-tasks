#!/usr/bin/env node
// Mechanical check of the service ownership in deployment/compose.production.yaml:
// RUNNER_TOKEN is interpolated into exactly the worker and browser-runner
// environments, never into api, and Postgres resolves to the existing Docker
// volume. deploy.sh validates the *rendered* values; this script ties the test
// fixture back to the real service definitions so a token moved to the wrong
// service or a renamed volume fails instead of silently passing a hand-written
// fixture.
//
// Usage:
//   node scripts/check-deploy-compose-contract.mjs
//   node scripts/check-deploy-compose-contract.mjs --fixture <rendered-config.json>
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composePath = resolve(root, 'deployment/compose.production.yaml');

// Extract service -> environment keys from the indentation-based YAML used by
// this repository. It deliberately does not implement YAML aliases: `<<: *x`
// is an alias line, not a key, and RUNNER_TOKEN is always explicit.
function serviceEnvironmentKeys(source) {
  const services = new Map();
  let inServices = false;
  let current = '';
  let inEnvironment = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line === '' || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = line === 'services:';
      current = '';
      inEnvironment = false;
      continue;
    }
    if (!inServices) continue;
    if (indent === 2) {
      const match = /^ {2}([A-Za-z0-9_.-]+):(?:\s.*)?$/.exec(line);
      if (match) {
        current = match[1];
        services.set(current, new Set());
      }
      inEnvironment = false;
      continue;
    }
    if (indent === 4) {
      inEnvironment = line === '    environment:';
      continue;
    }
    if (indent === 6 && inEnvironment && current) {
      const match = /^ {6}([A-Z_][A-Z0-9_]*):/.exec(line);
      if (match) services.get(current).add(match[1]);
    }
  }
  return services;
}

function tokenOwners(services) {
  const owners = [];
  for (const [name, keys] of services) {
    if (keys.has('RUNNER_TOKEN')) owners.push(name);
  }
  return owners.sort();
}

function fixtureEnvironment(fixture, name) {
  const environment = fixture?.services?.[name]?.environment;
  return environment && typeof environment === 'object' ? environment : {};
}

function postgresDockerVolumeName(fixture) {
  const mounts = Array.isArray(fixture?.services?.postgres?.volumes)
    ? fixture.services.postgres.volumes
    : [];
  const mount = mounts.find(
    (volume) => volume && volume.target === '/var/lib/postgresql/data'
  );
  if (mount?.type !== 'volume' || typeof mount.source !== 'string') return '';
  const definition = fixture?.volumes?.[mount.source];
  return typeof definition?.name === 'string' ? definition.name : '';
}

const errors = [];
const composeSource = readFileSync(composePath, 'utf8');
const defined = serviceEnvironmentKeys(composeSource);
if (defined.size === 0) {
  errors.push('could not read any service environment from deployment/compose.production.yaml');
}

// The project name plus the logical postgres-data declaration must render to
// the existing Docker volume. CI also checks the actual Compose JSON output.
const projectDeclared = /^name:\s*agent-tasks\s*$/m.test(composeSource);
if (!projectDeclared) {
  errors.push('compose.production.yaml must declare project name agent-tasks');
}
const postgresVolumeDeclared =
  /^ {6}- postgres-data:\/var\/lib\/postgresql\/data\s*$/m.test(composeSource);
if (!postgresVolumeDeclared) {
  errors.push(
    'compose.production.yaml must mount postgres-data at /var/lib/postgresql/data'
  );
}
if (!/^ {2}postgres-data:\s*$/m.test(composeSource)) {
  errors.push('compose.production.yaml must declare the top-level postgres-data volume');
}

const expectedOwners = ['browser-runner', 'worker'];
const owners = tokenOwners(defined);
if (JSON.stringify(owners) !== JSON.stringify(expectedOwners)) {
  errors.push(
    `RUNNER_TOKEN must be interpolated into browser-runner and worker only (found: ${owners.join(', ') || 'none'})`
  );
}

const fixtureArgument = process.argv.indexOf('--fixture');
if (fixtureArgument !== -1) {
  const fixturePath = process.argv[fixtureArgument + 1];
  if (!fixturePath) {
    errors.push('--fixture requires a path to a rendered Compose JSON document');
  } else {
    let fixture;
    try {
      fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8'));
    } catch (error) {
      errors.push(`could not read the rendered fixture: ${error.message}`);
      fixture = {};
    }

    const apiEnvironment = fixtureEnvironment(fixture, 'api');
    const workerEnvironment = fixtureEnvironment(fixture, 'worker');
    const runnerEnvironment = fixtureEnvironment(fixture, 'browser-runner');
    const workerToken = workerEnvironment.RUNNER_TOKEN;
    const runnerToken = runnerEnvironment.RUNNER_TOKEN;

    if (typeof workerToken !== 'string' || workerToken === '') {
      errors.push('fixture worker environment must carry RUNNER_TOKEN');
    }
    if (runnerToken !== workerToken) {
      errors.push('fixture browser-runner RUNNER_TOKEN must equal the worker token');
    }
    if (apiEnvironment.RUNNER_TOKEN !== undefined) {
      errors.push('fixture api environment must not carry RUNNER_TOKEN');
    }

    if (postgresDockerVolumeName(fixture) !== 'agent-tasks_postgres-data') {
      errors.push(
        'fixture postgres must resolve to Docker volume agent-tasks_postgres-data at /var/lib/postgresql/data'
      );
    }

    const fixtureOwners = tokenOwners(
      new Map(
        Object.entries(fixture.services ?? {})
          .filter(([, service]) => service && typeof service === 'object')
          .map(([name, service]) => [
            name,
            new Set(Object.keys(service.environment ?? {}))
          ])
      )
    );
    if (JSON.stringify(fixtureOwners) !== JSON.stringify(owners)) {
      errors.push(
        `fixture RUNNER_TOKEN owners (${fixtureOwners.join(', ') || 'none'}) do not match compose.production.yaml (${owners.join(', ') || 'none'})`
      );
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`deploy compose contract: ${error}`);
  process.exit(1);
}

console.log(
  'deploy compose contract: OK (RUNNER_TOKEN on worker and browser-runner only, fixture matches the real service definitions)'
);
