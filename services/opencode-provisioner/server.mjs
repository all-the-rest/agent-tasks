import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { once } from 'node:events';

const LABEL = 'com.agent-tasks.runtime';
const IMAGE = process.env.OPENCODE_RUNTIME_IMAGE ?? 'agent-tasks-opencode:spike';
const NETWORK_ALIAS = 'opencode-provisioner';
const API_PORT = 4090;
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_PROXY_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
const runtimes = new Map();
const networkAttachments = new Map();

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function hmac(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a !== 0 && a !== 10 && a !== 127 && a < 224
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 0 || b === 2 || b === 168))
      && !(a === 192 && b === 88 && octets[2] === 99)
      && !(a === 198 && (b === 18 || b === 19 || b === 51 && octets[2] === 100))
      && !(a === 203 && b === 0 && octets[2] === 113);
  }
  const value = address.toLowerCase();
  const firstHextet = Number.parseInt(value.split(':')[0] || '0', 16);
  return !value.includes('%') && firstHextet >= 0x2000 && firstHextet <= 0x3fff
    && !value.startsWith('2001:db8:') && !value.startsWith('2001:10:')
    && !value.startsWith('2001:20:') && !value.startsWith('2002:');
}

async function providerUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Provider endpoint must be a public HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password
    || url.search || !url.hostname || isIP(url.hostname) || url.hostname === 'localhost' || !url.hostname.includes('.')) {
    throw new Error('Provider endpoint must be a public HTTPS URL');
  }
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => !publicAddress(record.address))) {
    throw new Error('Provider endpoint must resolve only to public IP addresses');
  }
  url.hash = '';
  return url;
}

function safeProviderHeaders(provider, executionId) {
  const source = provider.headers && typeof provider.headers === 'object' && !Array.isArray(provider.headers)
    ? provider.headers : {};
  const headers = {};
  const secrets = {};
  let secretIndex = 0;
  const addSecretHeader = (name, value) => {
    const environmentName = `AGENT_TASKS_PROVIDER_HEADER_${secretIndex++}`;
    headers[name] = `{env:${environmentName}}`;
    secrets[environmentName] = value;
  };
  for (const [name, value] of Object.entries(source)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name) || typeof value !== 'string' || value.length > 600
      || /^(authorization|proxy-authorization|cookie|host|x-api-key|x-agent-tasks-egress)$/i.test(name)) {
      throw new Error('Provider has unsupported custom headers');
    }
    addSecretHeader(name, value);
  }
  const sessionHeader = typeof provider.sessionHeader === 'string' ? provider.sessionHeader : 'x-opencode-session';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(sessionHeader)) throw new Error('Invalid provider session header');
  headers[sessionHeader] = executionId;
  if (typeof provider.userAgent === 'string') addSecretHeader('User-Agent', provider.userAgent.slice(0, 120));
  if (typeof provider.organization === 'string' && provider.organization.length <= 120) {
    addSecretHeader('OpenAI-Organization', provider.organization);
  }
  return { headers, secrets };
}

export function runtimeConfig(input, providerBaseUrl) {
  const model = input.provider.models.find((entry) => entry.id === input.model.id);
  if (!model) throw new Error('Task model is not configured on its provider');
  const { headers } = safeProviderHeaders(input.provider, input.lease.executionId);
  headers['x-agent-tasks-egress'] = '{env:AGENT_TASKS_EGRESS_TOKEN}';
  // OpenCode prefixes MCP tool names with the server key. The wildcard deny is
  // evaluated last, so each bridge tool needs an explicit allow after it.
  const bridgeTools = input.toolBridge?.tools ?? [];
  // Without `tool_call` OpenCode never offers tools to the model, even when an
  // MCP server is connected and allowed.
  const modelConfig = { name: model.label ?? model.id, tool_call: model.supportsTools === true };
  modelConfig.limit = {
    ...(Number.isInteger(model.contextLength) && model.contextLength > 0 ? { context: model.contextLength } : {}),
    output: Math.max(1, Math.floor(input.maxOutputBytes / 4)),
  };
  const timeout = Number.isInteger(input.provider.timeoutMs) ? input.provider.timeoutMs : 120_000;
  return {
    $schema: 'https://opencode.ai/config.json',
    update: 'disable',
    model: `agent_tasks/${model.id}`,
    plugins: [],
    mcp: {
      servers: input.toolBridge ? {
        agent_tasks_tools: {
          type: 'remote',
          url: `http://${NETWORK_ALIAS}:${API_PORT}/mcp`,
          headers: { authorization: `Bearer ${input.toolBridge.token}` },
          codemode: false,
          timeout: { startup: 10_000, catalog: 10_000, execution: 60_000 },
        },
      } : {},
    },
    default_agent: 'agent-tasks',
    // The proven OpenCode 2.2.5 configuration: the provider and the MCP server
    // need explicit policy allows before the agent's tool allow is effective.
    policies: [
      { action: 'provider.use', resource: 'agent_tasks', effect: 'allow' },
      ...(input.toolBridge ? [{ action: 'mcp.use', resource: 'agent_tasks_tools', effect: 'allow' }] : []),
    ],
    agents: {
      'agent-tasks': {
        description: 'Agent Tasks execution with only the bridged tools allowed.',
        mode: 'primary',
        steps: input.maxAgentSteps,
        system: input.systemPrompt,
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          ...bridgeTools.map((tool) => ({ action: `agent_tasks_tools_${tool}`, resource: '*', effect: 'allow' })),
        ],
      },
    },
    providers: {
      agent_tasks: {
        name: 'Agent Tasks isolated provider',
        ...(input.apiKey ? { env: ['AGENT_TASKS_API_KEY'] } : {}),
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: providerBaseUrl, timeout },
        headers,
        models: { [model.id]: modelConfig },
      },
    },
  };
}

function docker(args, input, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DOCKER_BIN ?? 'docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const stdout = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Container operation failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Container operation failed'));
      else resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
    child.stdin.on('error', () => undefined);
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function volume(name, labelValue) {
  const existing = await docker(['volume', 'ls', '--quiet', '--filter', `name=^${name}$`]);
  if (existing) {
    const labels = JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .Labels}}', name]));
    if (labels?.[`${LABEL}.resource`] !== labelValue) throw new Error('Runtime volume ownership mismatch');
    return false;
  }
  await docker(['volume', 'create', '--label', `${LABEL}.resource=${labelValue}`, name]);
  return true;
}

async function network(name, executionHash, ownerHash) {
  const existing = await docker(['network', 'ls', '--quiet', '--filter', `name=^${name}$`]);
  if (existing) {
    const info = JSON.parse(await docker(['network', 'inspect', '--format', '{{json .}}', name]));
    if (info?.Labels?.[`${LABEL}.execution`] !== executionHash || info?.Labels?.[`${LABEL}.owner`] !== ownerHash || info?.Internal !== true) {
      throw new Error('Runtime network ownership mismatch');
    }
    return false;
  }
  await docker(['network', 'create', '--internal', '--label', `${LABEL}.execution=${executionHash}`, '--label', `${LABEL}.owner=${ownerHash}`, name]);
  return true;
}

async function attachRuntimeNetwork(state) {
  let pending = networkAttachments.get(state.network);
  if (!pending) {
    pending = (async () => {
      const serviceName = process.env.PROVISIONER_CONTAINER_NAME ?? 'agent-tasks-opencode-provisioner';
      const serviceId = await docker(['inspect', '--format', '{{.Id}}', serviceName]);
      const networkInfo = JSON.parse(await docker(['network', 'inspect', '--format', '{{json .Containers}}', state.network]));
      const connected = Object.values(networkInfo ?? {}).some((container) => container.Name === serviceName);
      if (!connected) await docker(['network', 'connect', '--alias', NETWORK_ALIAS, state.network, serviceId]);
      return { serviceId, connected };
    })();
    networkAttachments.set(state.network, pending);
    pending.catch(() => {
      if (networkAttachments.get(state.network) === pending) networkAttachments.delete(state.network);
    });
  }
  await pending;
}

async function withRuntimeNetwork(state, action) {
  // Prompt admission is asynchronous: OpenCode may call the provider after the
  // HTTP request returns, so the provisioner must stay attached until release.
  await attachRuntimeNetwork(state);
  return action();
}

async function detachRuntimeNetwork(state) {
  const pending = networkAttachments.get(state.network);
  if (pending) await pending.catch(() => undefined);
  const serviceName = process.env.PROVISIONER_CONTAINER_NAME ?? 'agent-tasks-opencode-provisioner';
  await docker(['network', 'disconnect', state.network, serviceName]).catch(() => undefined);
  networkAttachments.delete(state.network);
}

async function containerExists(name) {
  const id = await docker(['container', 'ls', '--all', '--quiet', '--filter', `name=^/${name}$`]);
  return id.split('\n')[0]?.trim() ?? '';
}

async function prepareRuntime(input, token) {
  const ownerHash = hash(input.lease.ownerId);
  const executionHash = hash(input.lease.executionId);
  const containerName = `agent-tasks-oc-${executionHash}`;
  const dataVolume = `agent-tasks-oc-data-${executionHash}`;
  const configVolume = `agent-tasks-oc-config-${executionHash}`;
  const networkName = `agent-tasks-oc-net-${executionHash}`;
  const egressToken = hmac(token, `egress:${input.lease.executionId}:${ownerHash}`);
  const password = hmac(token, `server:${input.lease.executionId}:${ownerHash}`);
  let stage = 'validate provider configuration';
  const providerHeaderConfig = safeProviderHeaders(input.provider, input.lease.executionId);
  const providerHeaders = providerHeaderConfig.secrets;
  const upstream = await providerUrl(input.provider.baseUrl);
  const state = {
    ownerHash,
    executionHash,
    executionId: input.lease.executionId,
    containerName,
    dataVolume,
    configVolume,
    network: networkName,
    upstream,
    providerHeaderNames: new Set(Object.keys(providerHeaderConfig.headers).map((name) => name.toLowerCase())),
  };
  let createdNetwork = false;
  let createdDataVolume = false;
  let createdConfigVolume = false;
  try {
    stage = 'create execution network';
    createdNetwork = await network(networkName, executionHash, ownerHash);
    stage = 'attach provisioner to execution network';
    await withRuntimeNetwork(state, async () => {
      stage = 'inspect existing runtime';
      const old = await containerExists(containerName);
      if (old) {
        const labels = JSON.parse(await docker(['inspect', '--format', '{{json .Config.Labels}}', old]));
        if (labels?.[`${LABEL}.owner`] !== ownerHash || labels?.[`${LABEL}.execution`] !== executionHash) {
          throw new Error('Runtime container ownership mismatch');
        }
        await docker(['rm', '--force', old]);
      }
      stage = 'create runtime volumes';
      createdDataVolume = await volume(dataVolume, `${executionHash}:${ownerHash}:data`);
      createdConfigVolume = await volume(configVolume, `${executionHash}:${ownerHash}:config`);
      const providerBaseUrl = `http://${NETWORK_ALIAS}:${API_PORT}/v1/runtime/${input.lease.executionId}/provider`;
      const config = JSON.stringify(runtimeConfig(input, providerBaseUrl));
      stage = 'write runtime configuration';
      await docker([
        'run', '--interactive', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--mount', `type=volume,src=${configVolume},dst=/run/config`, '--entrypoint', 'sh', IMAGE,
        '-ec', 'umask 022; if [ -f /run/config/opencode.json ]; then chmod 0600 /run/config/opencode.json; fi; cat > /run/config/opencode.json; chmod 0444 /run/config/opencode.json',
      ], config);
      stage = 'create runtime container';
      await docker([
        'create', '--name', containerName, '--network', networkName, '--network-alias', 'opencode-runtime',
        '--label', `${LABEL}.execution=${executionHash}`, '--label', `${LABEL}.owner=${ownerHash}`,
        '--label', `${LABEL}.created=${Date.now()}`,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
        '--memory', memoryLimit(), '--cpus', cpuLimit(),
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m,mode=1777',
        '--tmpfs', '/run/agent-tasks:rw,noexec,nosuid,size=1m,mode=0700,uid=10001,gid=10001',
        '--tmpfs', '/home/opencode/.config:rw,noexec,nosuid,size=16m,mode=0700,uid=10001,gid=10001',
        '--tmpfs', '/home/opencode/.local/state:rw,noexec,nosuid,size=16m,mode=0700,uid=10001,gid=10001',
        '--tmpfs', '/home/opencode/.cache:rw,noexec,nosuid,size=128m,mode=0700,uid=10001,gid=10001',
        '--mount', `type=volume,src=${dataVolume},dst=/home/opencode/.local/share/opencode`,
        '--mount', `type=volume,src=${configVolume},dst=/etc/opencode,readonly`,
        '--entrypoint', '/bin/sleep', IMAGE, 'infinity',
      ]);
      stage = 'start runtime container';
      await docker(['start', containerName]);
      const runtimeSecrets = {
        OPENCODE_SERVER_PASSWORD: password,
        AGENT_TASKS_API_KEY: input.apiKey ?? '',
        AGENT_TASKS_EGRESS_TOKEN: egressToken,
        ...providerHeaders,
      };
      stage = 'write runtime secrets';
      for (const [name, value] of Object.entries(runtimeSecrets)) await writeRuntimeSecret(containerName, name, value);
      const exports = Object.keys(runtimeSecrets).map((name) => `export ${name}="$(cat /run/agent-tasks/${name})"`).join('; ');
      stage = 'start OpenCode server';
      await docker([
        'exec', '--detach', '--user', '10001:10001', containerName,
        'sh', '-ec', `${exports}; exec /usr/local/bin/opencode serve --hostname 0.0.0.0 --port 4096`,
      ]);
      stage = 'wait for OpenCode readiness';
      await waitForRuntime(state, password);
    });
    const baseUrl = `${process.env.PROVISIONER_PUBLIC_URL ?? `http://${NETWORK_ALIAS}:${API_PORT}`}/v1/runtime/${input.lease.executionId}/`;
    return { state, response: { baseUrl, password, directory: '/workspace', model: { providerID: 'agent_tasks', id: input.model.id } } };
  } catch (error) {
    // Keep diagnostics useful without logging credentials, provider URLs, or
    // provider configuration received in the request body.
    const httpStatus = typeof error?.httpStatus === 'number' ? error.httpStatus : undefined;
    const connectionError = typeof error?.connectionError === 'string' ? error.connectionError : undefined;
    const runtimeStatus = await docker(['inspect', '--format', '{{.State.Status}}:{{.State.ExitCode}}', containerName]).catch(() => undefined);
    console.error(JSON.stringify({
      event: 'opencode_runtime_open_failed',
      stage,
      ...(httpStatus ? { httpStatus } : {}),
      ...(connectionError ? { connectionError } : {}),
      ...(runtimeStatus ? { runtimeStatus } : {}),
    }));
    await docker(['rm', '--force', containerName]).catch(() => undefined);
    await detachRuntimeNetwork(state);
    if (createdNetwork) await docker(['network', 'rm', networkName]).catch(() => undefined);
    if (createdConfigVolume) await docker(['volume', 'rm', configVolume]).catch(() => undefined);
    if (createdDataVolume) await docker(['volume', 'rm', dataVolume]).catch(() => undefined);
    throw error;
  }
}

async function writeRuntimeSecret(containerName, name, value) {
  await docker(['exec', '--interactive', '--user', '10001:10001', containerName, 'sh', '-ec', `umask 077; cat > /run/agent-tasks/${name}`], value);
}

async function waitForRuntime(state, password) {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  let lastHttpStatus;
  let lastConnectionError;
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await globalThis.fetch(`http://${state.containerName}:4096/api/info`, { headers: { authorization }, signal: globalThis.AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastHttpStatus = response.status;
    } catch (error) {
      // The process is still starting; don't include request errors or credentials in logs.
      const code = error?.cause?.code ?? error?.code;
      if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) lastConnectionError = code;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const error = new Error('Isolated OpenCode runtime did not become ready');
  error.httpStatus = lastHttpStatus;
  error.connectionError = lastConnectionError;
  throw error;
}

async function readJson(request, maximum = MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : undefined;
}

function authenticated(request, token) {
  const authorization = request.headers.authorization ?? '';
  return authorization.startsWith('Bearer ') && constantTimeEqual(authorization.slice(7), token);
}

function runtimeBasic(request, password) {
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  return constantTimeEqual(request.headers.authorization ?? '', expected);
}

function validateInput(value) {
  if (!value || typeof value !== 'object' || !value.lease || !validUuid(value.lease.executionId)
    || !validUuid(value.lease.ownerId) || typeof value.lease.workerId !== 'string' || value.lease.workerId.length > 200
    || value.providerKind !== 'openai-compatible' || !value.provider || typeof value.provider !== 'object'
    || typeof value.provider.baseUrl !== 'string' || typeof value.model?.id !== 'string' || value.model.id.length < 1 || value.model.id.length > 120
    || typeof value.systemPrompt !== 'string' || value.systemPrompt.length > 65_536
    || !Number.isInteger(value.maxAgentSteps) || value.maxAgentSteps < 1 || value.maxAgentSteps > 60
    || !Number.isInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > MAX_REQUEST_BYTES
    || typeof value.apiKey !== 'undefined' && (typeof value.apiKey !== 'string' || value.apiKey.length > 8_192)
    || typeof value.toolBridge !== 'undefined' && (!value.toolBridge || typeof value.toolBridge !== 'object'
      || typeof value.toolBridge.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.toolBridge.token)
      || !Array.isArray(value.toolBridge.tools) || value.toolBridge.tools.length > 16
      || !value.toolBridge.tools.every((tool) => typeof tool === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(tool)))) {
    throw new Error('Invalid isolated runtime request');
  }
  if (!Array.isArray(value.provider.models) || !value.provider.models.some((model) => model?.id === value.model.id)) {
    throw new Error('Task model is not configured on its provider');
  }
  return value;
}

async function proxyToolBridge(request, response) {
  const target = process.env.TOOL_BRIDGE_URL ?? 'http://worker:4091/mcp';
  const headers = {};
  for (const name of ['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const body = request.method === 'POST'
    ? JSON.stringify(await readJson(request, MAX_REQUEST_BYTES))
    : undefined;
  const upstream = await globalThis.fetch(target, {
    method: request.method,
    headers,
    body,
    signal: globalThis.AbortSignal.timeout(request.method === 'GET' ? 10 * 60_000 : 60_000),
  });
  response.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    ...(upstream.headers.get('mcp-session-id') ? { 'mcp-session-id': upstream.headers.get('mcp-session-id') } : {}),
    'cache-control': 'no-store',
  });
  response.flushHeaders();
  await streamBounded(upstream.body, response, MAX_PROXY_RESPONSE_BYTES);
}

async function proxyRuntime(request, response, state, token) {
  const provisionerToken = request.headers['x-provisioner-token'];
  if (typeof provisionerToken !== 'string' || !constantTimeEqual(provisionerToken, token)) return send(response, 401, { error: 'unauthorized' });
  const password = hmac(token, `server:${state.executionId}:${state.ownerHash}`);
  if (!runtimeBasic(request, password)) return send(response, 401, { error: 'unauthorized' });
  const url = new URL(request.url, 'http://provisioner.invalid');
  const prefix = `/v1/runtime/${state.executionId}/`;
  const apiPath = url.pathname.slice(prefix.length);
  if (!allowedOpenCodeRoute(request.method, apiPath)) return send(response, 404, { error: 'not found' });
  const body = request.method === 'GET' ? undefined : await readJson(request, MAX_REQUEST_BYTES).then((value) => JSON.stringify(value));
  await withRuntimeNetwork(state, async () => {
    const upstream = await globalThis.fetch(`http://${state.containerName}:4096/${apiPath}${url.search}`, {
      method: request.method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
      signal: globalThis.AbortSignal.timeout(60_000),
    });
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    await streamBounded(upstream.body, response, MAX_PROXY_RESPONSE_BYTES);
  });
}

async function releaseRuntime(request, response, state, token) {
  const provisionerToken = request.headers['x-provisioner-token'];
  if (typeof provisionerToken !== 'string' || !constantTimeEqual(provisionerToken, token)) return send(response, 401, { error: 'unauthorized' });
  const password = hmac(token, `server:${state.executionId}:${state.ownerHash}`);
  const supplied = request.headers['x-runtime-password'];
  if (typeof supplied !== 'string' || !constantTimeEqual(supplied, password)) return send(response, 401, { error: 'unauthorized' });
  await docker(['stop', '--time', '5', state.containerName]).catch(() => undefined);
  await detachRuntimeNetwork(state);
  return send(response, 200, { released: true });
}

export function allowedOpenCodeRoute(method, path) {
  return method === 'POST' && /^api\/session\/?$/.test(path)
    || method === 'POST' && /^api\/session\/[A-Za-z0-9_-]+\/(prompt|interrupt)$/.test(path)
    || method === 'GET' && /^api\/session\/[A-Za-z0-9_-]+\/message$/.test(path)
    || method === 'GET' && path === 'api/mcp';
}

async function proxyProvider(request, response, state, token) {
  const auth = request.headers['x-agent-tasks-egress'];
  const expected = hmac(token, `egress:${state.executionId}:${state.ownerHash}`);
  if (typeof auth !== 'string' || !constantTimeEqual(auth, expected)) return send(response, 403, { error: 'forbidden' });
  if (!['GET', 'POST'].includes(request.method) || !/^\/(v1\/)?(models|chat\/completions)$/.test(new URL(request.url, 'http://x').pathname.slice(`/v1/runtime/${state.executionId}/provider`.length))) {
    return send(response, 404, { error: 'not found' });
  }
  await proxyProviderRequest(request, response, state);
}

async function proxyProviderRequest(request, response, state) {
  const addresses = await lookup(state.upstream.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((record) => !publicAddress(record.address))) {
    return send(response, 403, { error: 'provider endpoint blocked' });
  }
  const pathPrefix = state.upstream.pathname.replace(/\/+$/, '');
  const routePrefix = `/v1/runtime/${state.executionId}/provider`;
  const incoming = new URL(request.url, 'http://provisioner.invalid');
  const suffix = incoming.pathname.slice(routePrefix.length);
  const path = `${pathPrefix}/${suffix.replace(/^\/+/, '')}${incoming.search}`;
  const headers = providerRequestHeaders(request.headers, state.providerHeaderNames);
  headers.host = state.upstream.host;
  const selected = addresses[0];
  const upstream = httpsRequest({
    protocol: 'https:',
    hostname: selected.address,
    family: selected.family,
    port: 443,
    servername: state.upstream.hostname,
    method: request.method,
    path,
    headers,
    timeout: 30_000,
    lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, {
      ...(upstreamResponse.headers['content-type'] ? { 'content-type': upstreamResponse.headers['content-type'] } : {}),
      ...(upstreamResponse.headers['cache-control'] ? { 'cache-control': upstreamResponse.headers['cache-control'] } : {}),
      'x-content-type-options': 'nosniff',
    });
    let size = 0;
    upstreamResponse.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PROXY_RESPONSE_BYTES) upstreamResponse.destroy(new Error('response limit'));
      else response.write(chunk);
    });
    upstreamResponse.on('end', () => response.end());
    upstreamResponse.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  let requestSize = 0;
  request.on('data', (chunk) => {
    requestSize += chunk.length;
    if (requestSize > MAX_REQUEST_BYTES) upstream.destroy(new Error('request limit'));
    else upstream.write(chunk);
  });
  request.on('end', () => upstream.end());
  request.on('error', () => upstream.destroy());
}

export function providerRequestHeaders(requestHeaders, allowedHeaderNames = new Set()) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (typeof value !== 'string') continue;
    const lower = name.toLowerCase();
    if (['accept', 'content-type', 'authorization', 'openai-organization', 'user-agent'].includes(lower)
      || lower.startsWith('openai-') && lower !== 'openai-organization'
      || allowedHeaderNames.has(lower) && lower !== 'x-agent-tasks-egress') headers[lower] = value;
  }
  return headers;
}

async function streamBounded(body, response, maxBytes) {
  if (!body) return response.end();
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) {
      response.destroy();
      return;
    }
    if (!response.write(chunk)) await once(response, 'drain');
  }
  response.end();
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createProvisionerServer({ token = process.env.OPENCODE_PROVISIONER_TOKEN, provision = prepareRuntime } = {}) {
  if (!token || token.length < 32) throw new Error('OPENCODE_PROVISIONER_TOKEN must contain at least 32 characters');
  return createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://provisioner.invalid');
        if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { ok: true });
        // The per-execution runtime reaches the worker's MCP bridge through this
        // proxy; the bearer token is the only credential and the worker decides
        // whether the session is still alive.
        if (url.pathname === '/mcp' && ['GET', 'POST', 'DELETE'].includes(request.method)) {
          return await proxyToolBridge(request, response);
        }
        if (request.method === 'POST' && url.pathname === '/v1/runtimes/open') {
          if (!authenticated(request, token)) return send(response, 401, { error: 'unauthorized' });
          const input = validateInput(await readJson(request));
          const result = await provision(input, token);
          runtimes.set(input.lease.executionId, result.state);
          return send(response, 200, result.response);
        }
        const match = /^\/v1\/runtime\/([0-9a-f-]{36})\/(.*)$/.exec(url.pathname);
        if (match) {
          const state = runtimes.get(match[1]);
          if (!state) return send(response, 404, { error: 'runtime not found' });
          if (match[2] === 'release' && request.method === 'POST') return await releaseRuntime(request, response, state, token);
          if (match[2].startsWith('provider')) return await proxyProvider(request, response, state, token);
          return await proxyRuntime(request, response, state, token);
        }
        if (!authenticated(request, token)) return send(response, 401, { error: 'unauthorized' });
        return send(response, 404, { error: 'not found' });
      } catch {
        if (!response.headersSent) send(response, 502, { error: 'runtime operation failed' });
        else response.destroy();
      }
    })();
  });
}

async function cleanupExpired(ttlSeconds = Number(process.env.OPENCODE_RUNTIME_TTL_SECONDS ?? DEFAULT_TTL_SECONDS)) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 3_600 || ttlSeconds > 90 * 24 * 60 * 60) return;
  const names = await docker(['container', 'ls', '--all', '--quiet', '--filter', `label=${LABEL}.execution`]);
  for (const id of names.split('\n').filter(Boolean)) {
    try {
      const info = JSON.parse(await docker(['inspect', '--format', '{{json .}}', id]))[0];
      const label = info?.Config?.Labels?.[`${LABEL}.created`];
      const created = Number(label);
      if (!Number.isFinite(created) || Date.now() - created < ttlSeconds * 1_000) continue;
      const executionHash = info.Config.Labels[`${LABEL}.execution`];
      const ownerHash = info.Config.Labels[`${LABEL}.owner`];
      const suffix = executionHash;
      await docker(['rm', '--force', id]);
      const networkName = `agent-tasks-oc-net-${suffix}`;
      const serviceName = process.env.PROVISIONER_CONTAINER_NAME ?? 'agent-tasks-opencode-provisioner';
      await docker(['network', 'disconnect', networkName, serviceName]).catch(() => undefined);
      await docker(['network', 'rm', networkName]).catch(() => undefined);
      networkAttachments.delete(networkName);
      for (const prefix of ['agent-tasks-oc-data-', 'agent-tasks-oc-config-']) {
        const volumeName = `${prefix}${suffix}`;
        const labels = await docker(['volume', 'inspect', '--format', '{{json .Labels}}', volumeName]).then(JSON.parse).catch(() => null);
        if (labels?.[`${LABEL}.resource`]?.startsWith(`${suffix}:${ownerHash}:`)) await docker(['volume', 'rm', volumeName]).catch(() => undefined);
      }
      for (const [executionId, runtime] of runtimes) if (runtime.executionHash === executionHash) runtimes.delete(executionId);
    } catch {
      // Cleanup is best-effort and scoped only to resources with our dedicated labels.
    }
  }
}

function memoryLimit() {
  const value = process.env.OPENCODE_RUNTIME_MEMORY_LIMIT ?? '1g';
  if (!/^([1-9][0-9]*)([kmg])$/i.test(value)) throw new Error('Invalid OpenCode runtime memory limit');
  return value;
}

function cpuLimit() {
  const value = process.env.OPENCODE_RUNTIME_CPUS ?? '1.0';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 4) throw new Error('Invalid OpenCode runtime CPU limit');
  return value;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const server = createProvisionerServer();
  server.listen(API_PORT, '0.0.0.0');
  const sweep = setInterval(() => void cleanupExpired().catch(() => undefined), 60 * 60 * 1_000);
  sweep.unref();
  const shutdown = () => { clearInterval(sweep); server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
