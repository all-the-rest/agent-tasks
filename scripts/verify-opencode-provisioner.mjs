import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const baseUrl = new URL(process.env.OPENCODE_PROVISIONER_URL ?? process.env.PROVISIONER_PUBLIC_URL ?? 'http://127.0.0.1:4090');
const token = process.env.OPENCODE_PROVISIONER_TOKEN ?? '';
const provisionerContainer = process.env.PROVISIONER_CONTAINER_NAME ?? 'agent-tasks-opencode-provisioner';
const fakeApiKey = 'agent-tasks-provisioner-smoke-fake-key-never-used';
const rotatedApiKey = 'agent-tasks-provisioner-smoke-rotated-key-never-used';
const fakeHeader = 'agent-tasks-provisioner-smoke-fake-header-never-used';
const runtimes = [];

if (!['http:', 'https:'].includes(baseUrl.protocol) || token.length < 32) {
  throw new Error('Set OPENCODE_PROVISIONER_URL and a 32-character OPENCODE_PROVISIONER_TOKEN');
}

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const docker = (args) => execFileSync(process.env.DOCKER_BIN ?? 'docker', args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  pass(message);
}

async function responseJson(url, init) {
  const response = await globalThis.fetch(url, { ...init, signal: init.signal ?? globalThis.AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => undefined);
  return { response, body };
}

async function openRuntime(lease, apiKey = fakeApiKey) {
  const input = {
    lease: { ...lease, workerId: 'opencode-provisioner-smoke' },
    providerKind: 'openai-compatible',
    provider: {
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      models: [{ id: 'smoke-model', label: 'Smoke Model', supportsTools: true, contextLength: 32_000 }],
      headers: { 'x-agent-tasks-smoke': fakeHeader },
      sessionHeader: 'x-opencode-session',
      timeoutMs: 30_000,
    },
    model: { providerID: 'agent_tasks', id: 'smoke-model' },
    ...(apiKey === null ? {} : { apiKey }),
    systemPrompt: 'Provisioner lifecycle smoke test. Do not call tools.',
    maxAgentSteps: 4,
    maxOutputBytes: 8_192,
  };
  const { response, body } = await responseJson(new URL('/v1/runtimes/open', baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: globalThis.AbortSignal.timeout(60_000),
  });
  if (!response.ok || typeof body?.baseUrl !== 'string' || typeof body?.password !== 'string') {
    throw new Error(`runtime open failed (${response.status})`);
  }
  const runtime = { lease, ...body };
  runtimes.push(runtime);
  const runtimeUrl = new URL(runtime.baseUrl);
  if (runtimeUrl.origin !== baseUrl.origin || !runtimeUrl.pathname.startsWith('/v1/runtime/')) {
    throw new Error('provisioner returned an unexpected runtime URL');
  }
  return runtime;
}

function runtimeHeaders(runtime, password = runtime.password) {
  return {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'x-provisioner-token': token,
  };
}

async function runtimeRequest(runtime, path, init = {}, password = runtime.password) {
  return globalThis.fetch(new URL(path, runtime.baseUrl), {
    ...init,
    headers: {
      ...runtimeHeaders(runtime, password),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: init.signal ?? globalThis.AbortSignal.timeout(15_000),
  });
}

async function createSession(runtime) {
  const response = await runtimeRequest(runtime, 'api/session', {
    method: 'POST',
    body: JSON.stringify({ location: { directory: runtime.directory }, model: runtime.model }),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || typeof body?.data?.id !== 'string') throw new Error(`session create failed (${response.status})`);
  return body.data.id;
}

async function releaseRuntime(runtime) {
  const response = await globalThis.fetch(new URL('release', runtime.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-provisioner-token': token,
      'x-runtime-password': runtime.password,
    },
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`runtime release failed (${response.status})`);
}

function inspectJson(args) {
  return JSON.parse(docker(args));
}

function removeOwnedResources(runtime) {
  const executionHash = hash(runtime.lease.executionId);
  const ownerHash = hash(runtime.lease.ownerId);
  const container = `agent-tasks-oc-${executionHash}`;
  const network = `agent-tasks-oc-net-${executionHash}`;
  const labels = (resource) => {
    try {
      return inspectJson(['inspect', '--format', '{{json .Config.Labels}}', resource]);
    } catch {
      return undefined;
    }
  };
  const containerLabels = labels(container);
  if (containerLabels?.['com.agent-tasks.runtime.execution'] === executionHash
    && containerLabels?.['com.agent-tasks.runtime.owner'] === ownerHash) {
    docker(['rm', '--force', container]);
  }

  let networkLabels;
  try {
    networkLabels = inspectJson(['network', 'inspect', '--format', '{{json .Labels}}', network]);
  } catch {
    networkLabels = undefined;
  }
  if (networkLabels?.['com.agent-tasks.runtime.execution'] === executionHash
    && networkLabels?.['com.agent-tasks.runtime.owner'] === ownerHash) {
    try {
      docker(['network', 'disconnect', network, provisionerContainer]);
    } catch {
      // Release already detached the provisioner.
    }
    docker(['network', 'rm', network]);
  }

  for (const kind of ['data', 'config']) {
    const volume = `agent-tasks-oc-${kind}-${executionHash}`;
    let volumeLabels;
    try {
      volumeLabels = inspectJson(['volume', 'inspect', '--format', '{{json .Labels}}', volume]);
    } catch {
      volumeLabels = undefined;
    }
    if (volumeLabels?.['com.agent-tasks.runtime.resource'] === `${executionHash}:${ownerHash}:${kind}`) {
      docker(['volume', 'rm', volume]);
    }
  }
}

let testError;
try {
  const firstLease = { executionId: randomUUID(), ownerId: randomUUID() };
  const first = await openRuntime(firstLease);
  const firstHash = hash(firstLease.executionId);
  const firstContainer = `agent-tasks-oc-${firstHash}`;
  const firstNetwork = `agent-tasks-oc-net-${firstHash}`;
  const config = docker(['exec', firstContainer, 'cat', '/etc/opencode/opencode.json']);
  assert(!config.includes(fakeApiKey) && !config.includes(fakeHeader), 'persistent OpenCode config contains no provider secrets');
  const hasEgressReference = config.includes('{env:AGENT_TASKS_EGRESS_TOKEN}');
  const hasProviderHeaderReference = config.includes('{env:AGENT_TASKS_PROVIDER_HEADER_0}');
  assert(hasEgressReference && hasProviderHeaderReference, `persistent config references runtime-only secret variables (egress=${hasEgressReference}, providerHeader=${hasProviderHeaderReference})`);

  const runtimeKey = docker(['exec', firstContainer, 'cat', '/run/agent-tasks/AGENT_TASKS_API_KEY']);
  const runtimeHeader = docker(['exec', firstContainer, 'cat', '/run/agent-tasks/AGENT_TASKS_PROVIDER_HEADER_0']);
  const keyMode = docker(['exec', firstContainer, 'stat', '-c', '%a:%u:%g', '/run/agent-tasks/AGENT_TASKS_API_KEY']);
  const configMode = docker(['exec', firstContainer, 'stat', '-c', '%a:%u:%g', '/home/opencode/.config']);
  const stateMode = docker(['exec', firstContainer, 'stat', '-c', '%a:%u:%g', '/home/opencode/.local/state']);
  assert(runtimeKey === fakeApiKey && runtimeHeader === fakeHeader && keyMode === '600:10001:10001', 'API key and custom header are private per-runtime tmpfs files');
  assert(configMode === '700:10001:10001' && stateMode === '700:10001:10001', 'OpenCode config and state paths are writable, owner-only tmpfs');
  const version = docker(['exec', '--user', '10001:10001', firstContainer, '/usr/local/bin/opencode', '--version']);
  assert(version.includes('2.2.5'), 'isolated runtime starts the pinned OpenCode 2.2.5 binary');

  const firstSession = await createSession(first);
  pass('OpenCode session creation succeeds through the authenticated provisioner');
  const mcpStatus = await runtimeRequest(first, 'api/mcp');
  assert(mcpStatus.ok, 'MCP status is reachable through the authenticated runtime proxy');
  const mcpMutation = await runtimeRequest(first, 'api/mcp', { method: 'POST', body: '{}' });
  assert(mcpMutation.status === 404, 'MCP mutation is not exposed through the runtime proxy');
  const firstMembers = inspectJson(['network', 'inspect', '--format', '{{json .Containers}}', firstNetwork]);
  assert(Object.values(firstMembers).some((entry) => entry.Name === provisionerContainer), 'provisioner is attached for runtime proxy calls');
  await releaseRuntime(first);
  const releasedMembers = inspectJson(['network', 'inspect', '--format', '{{json .Containers}}', firstNetwork]);
  assert(!Object.values(releasedMembers).some((entry) => entry.Name === provisionerContainer), 'release detaches the provisioner from the execution network');

  const recovered = await openRuntime(firstLease, rotatedApiKey);
  const rotatedKey = docker(['exec', firstContainer, 'cat', '/run/agent-tasks/AGENT_TASKS_API_KEY']);
  const rotatedConfig = docker(['exec', firstContainer, 'cat', '/etc/opencode/opencode.json']);
  assert(rotatedKey === rotatedApiKey && !rotatedConfig.includes(fakeApiKey) && !rotatedConfig.includes(rotatedApiKey), 'recreated runtime receives the rotated key without persisting either key in config');
  const recoveredMessages = await runtimeRequest(recovered, `api/session/${encodeURIComponent(firstSession)}/message`);
  assert(recoveredMessages.ok, 'the OpenCode session survives container recreation for the same execution');

  await releaseRuntime(recovered);
  await openRuntime(firstLease, null);
  const revokedKey = docker(['exec', firstContainer, 'cat', '/run/agent-tasks/AGENT_TASKS_API_KEY']);
  const revokedConfig = docker(['exec', firstContainer, 'cat', '/etc/opencode/opencode.json']);
  assert(revokedKey === '' && !revokedConfig.includes('AGENT_TASKS_API_KEY'), 'recreated runtime receives no provider key after revocation');

  const secondLease = { executionId: randomUUID(), ownerId: randomUUID() };
  const second = await openRuntime(secondLease);
  const secondSession = await createSession(second);
  const foreignSession = await runtimeRequest(second, `api/session/${encodeURIComponent(firstSession)}/message`);
  assert(foreignSession.status !== 200, 'a runtime cannot read another execution session');
  const wrongCredential = await runtimeRequest(second, `api/session/${encodeURIComponent(secondSession)}/message`, {}, recovered.password);
  assert(wrongCredential.status === 401, 'a different execution credential is rejected by the provisioner');
  const secondNetwork = `agent-tasks-oc-net-${hash(secondLease.executionId)}`;
  const firstNetworkInfo = inspectJson(['network', 'inspect', '--format', '{{json .}}', firstNetwork]);
  const secondNetworkInfo = inspectJson(['network', 'inspect', '--format', '{{json .}}', secondNetwork]);
  const firstNetworkId = docker(['network', 'inspect', '--format', '{{.Id}}', firstNetwork]);
  const secondNetworkId = docker(['network', 'inspect', '--format', '{{.Id}}', secondNetwork]);
  assert(firstNetworkInfo.Internal === true && secondNetworkInfo.Internal === true, 'execution networks do not provide external connectivity');
  assert(firstNetworkId !== secondNetworkId, 'different executions receive distinct private Docker networks');
} catch (error) {
  testError = error;
} finally {
  for (const runtime of runtimes) {
    await releaseRuntime(runtime).catch(() => undefined);
    try {
      removeOwnedResources(runtime);
    } catch {
      testError ??= new Error('smoke test could not clean up its owned Docker resources');
    }
  }
}

if (testError) throw testError;
console.log('PASS all OpenCode provisioner lifecycle checks completed');
