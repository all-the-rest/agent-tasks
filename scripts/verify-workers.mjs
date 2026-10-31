/* eslint-disable no-undef -- standalone Node script run outside the bundler */
/**
 * Practical multi-worker verification against a running Compose stack.
 *
 * 1. scales the worker service to two containers (the CI step does the scaling),
 * 2. starts a slow OpenAI-compatible mock inside the compose network,
 * 3. runs six concurrent executions and asserts distinct workers, one row per
 *    execution and a 409 when a task is triggered twice,
 * 4. kills the worker that owns a running execution and waits for lease-based
 *    recovery on the surviving worker.
 *
 * Env: API_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, POSTGRES_USER/POSTGRES_DB
 * (defaults agent/agent_tasks), MOCK_IMAGE (defaults to the compose api image).
 */
import { execFileSync } from 'node:child_process';

const base = (process.env.API_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
const dbUser = process.env.POSTGRES_USER ?? 'agent';
const dbName = process.env.POSTGRES_DB ?? 'agent_tasks';
const DELAY_MS = 20_000;
const PARALLEL_RUNS = 6;

if (!adminEmail || !adminPassword) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required');
  process.exit(1);
}

const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const compose = (...args) =>
  execFileSync('docker', ['compose', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const psql = (sql) =>
  compose('exec', '-T', 'postgres', 'psql', '-U', dbUser, '-d', dbName, '-tAc', sql).trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cookie = '';

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

function check(condition, message, detail) {
  if (!condition) {
    console.error(`FAIL ${message}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`PASS ${message}`);
}

async function waitFor(description, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${description}`);
    await sleep(2_000);
  }
}

const taskPayload = (title, providerId) => ({
  title,
  prompt: 'Return a short deterministic answer for the worker check.',
  providerId,
  model: 'mock-slow',
  enabled: false,
  schedule: { preset: 'once', timezone: 'Europe/Vienna', runAt: new Date(Date.now() + 3_600_000).toISOString() },
  limits: {},
  allowWebResearch: false,
  notification: 'none',
});

let mockContainer = null;

try {
  // Scaling may recreate the api container (config change), so wait for it.
  await waitFor(
    'api readiness',
    async () => {
      try {
        return (await fetch(`${base}/api/healthz`)).ok;
      } catch {
        return false;
      }
    },
    120_000,
  );
  console.log('PASS api is healthy');

  // --- admin session -------------------------------------------------------
  const login = await call('POST', '/api/auth/sign-in/email', { email: adminEmail, password: adminPassword });
  check(login.status === 200, 'admin signs in');

  // Six executions must be allowed to run at once; the default per-user limit is 2.
  const settings = await call('PUT', '/api/admin/settings', {
    maxConcurrentExecutionsPerUser: 10,
    maxTaskExecutionsPerDay: 100,
  });
  check(settings.status === 200, 'per-user concurrency limit raised for the check');

  // --- slow mock inside the compose network --------------------------------
  const network = docker('network', 'ls', '--format', '{{.Name}}')
    .split('\n')
    .find((name) => name.endsWith('_backend'));
  check(Boolean(network), 'compose backend network found', network);

  const image = process.env.MOCK_IMAGE ?? compose('images', '-q', 'api').split('\n')[0];
  check(Boolean(image), 'api image available for the mock', image);

  docker('rm', '-f', 'worker-check-mock').toString();
  docker(
    'run', '-d', '--rm', '--name', 'worker-check-mock',
    '--network', network,
    '-v', `${process.cwd()}/scripts/slow-mock.mjs:/mock.mjs:ro`,
    '-e', `DELAY_MS=${DELAY_MS}`,
    '-e', 'PORT=18099',
    '--entrypoint', 'node',
    image, '/mock.mjs',
  );
  mockContainer = 'worker-check-mock';
  await waitFor('mock readiness', () => docker('logs', mockContainer).includes('MOCK_READY'), 30_000);
  console.log('PASS slow mock is reachable inside the compose network');

  // --- provider ------------------------------------------------------------
  const provider = await call('POST', '/api/admin/providers', {
    name: `Worker Check ${Date.now()}`,
    kind: 'openai-compatible',
    config: {
      baseUrl: 'http://worker-check-mock:18099/v1',
      models: [{ id: 'mock-slow', supportsTools: false }],
      stream: false,
    },
    enabled: true,
    isDefault: true,
  });
  check(provider.status === 201, 'mock provider created', provider);
  const providerId = provider.json.id;
  const credential = await call('POST', `/api/admin/providers/${providerId}/credentials`, {
    apiKey: 'worker-check-key',
    label: 'worker-check',
  });
  check(credential.status === 201, 'shared credential stored');

  // --- parallel executions on two workers ----------------------------------
  const tasks = [];
  for (let index = 0; index < PARALLEL_RUNS; index += 1) {
    const created = await call('POST', '/api/tasks', taskPayload(`Worker check ${index} ${Date.now()}`, providerId));
    check(created.status === 201, `task ${index} created`, created);
    tasks.push(created.json.id);
  }

  const runs = await Promise.all(tasks.map((taskId) => call('POST', `/api/tasks/${taskId}/run`)));
  for (const [index, run] of runs.entries()) check(run.status === 200, `run ${index} accepted`, run);
  const executionIds = runs.map((run) => run.json.executionId);

  const duplicate = await call('POST', `/api/tasks/${tasks[0]}/run`);
  check(duplicate.status === 409, 'second run of an active task is refused (409)', duplicate);

  const rows = await waitFor(
    'all parallel executions to complete',
    () => {
      const list = executionIds.map((id) => `'${id}'`).join(',');
      const parsed = psql(
        `select id||'|'||coalesce(worker_id::text,'')||'|'||status from executions where id in (${list})`,
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id, workerId, status] = line.split('|');
          return { id, workerId, status };
        });
      return parsed.length === executionIds.length && parsed.every((row) => row.status === 'completed') ? parsed : null;
    },
    300_000,
  );

  const workers = new Set(rows.map((row) => row.workerId).filter(Boolean));
  check(workers.size >= 2, 'at least two worker containers claimed executions', [...workers]);
  check(new Set(rows.map((row) => row.id)).size === executionIds.length, 'every execution has exactly one row');

  const executionsForFirstTask = Number(
    psql(`select count(*) from executions where task_id = '${tasks[0]}'`),
  );
  check(executionsForFirstTask === 1, 'the duplicate attempt created no second execution', executionsForFirstTask);

  // --- crash recovery ------------------------------------------------------
  const crashTask = await call('POST', '/api/tasks', taskPayload(`Worker crash ${Date.now()}`, providerId));
  check(crashTask.status === 201, 'crash task created', crashTask);
  const crashRun = await call('POST', `/api/tasks/${crashTask.json.id}/run`);
  check(crashRun.status === 200, 'crash run accepted', crashRun);
  const crashId = crashRun.json.executionId;

  const running = await waitFor(
    'the crash execution to start',
    () => {
      const line = psql(`select coalesce(worker_id::text,'')||'|'||status from executions where id = '${crashId}'`);
      const [workerId, status] = line.split('|');
      return status === 'running' && workerId ? { workerId } : null;
    },
    90_000,
  );
  const killedWorker = running.workerId;
  console.log(`PAUSE execution ${crashId} is running on worker ${killedWorker}`);

  const workerContainers = compose('ps', '-q', 'worker').split('\n').filter(Boolean);
  let owner = null;
  for (const container of workerContainers) {
    try {
      if (docker('logs', container).includes(killedWorker)) owner = container;
    } catch {
      /* ignore */
    }
  }
  check(Boolean(owner), 'owning worker container found', { killedWorker, workerContainers });

  docker('update', '--restart=no', owner);
  docker('kill', owner);
  console.log(`PAUSE killed worker container ${owner}`);

  const recovered = await waitFor(
    'lease recovery to complete the execution on the surviving worker',
    () => {
      const line = psql(`select coalesce(worker_id::text,'')||'|'||status from executions where id = '${crashId}'`);
      const [workerId, status] = line.split('|');
      return status === 'completed' && workerId && workerId !== killedWorker ? { workerId } : null;
    },
    420_000,
  );
  console.log(`PASS recovered execution completed on worker ${recovered.workerId}`);

  const crashRows = Number(psql(`select count(*) from executions where task_id = '${crashTask.json.id}'`));
  check(crashRows === 1, 'crash recovery reused the execution row (no duplicate)', crashRows);

  // Restore the killed container for the rest of the job.
  docker('start', owner);
  docker('update', '--restart=unless-stopped', owner);

  console.log('WORKERS_OK');
} finally {
  if (mockContainer) {
    try {
      docker('rm', '-f', mockContainer);
    } catch {
      /* ignore */
    }
  }
}
