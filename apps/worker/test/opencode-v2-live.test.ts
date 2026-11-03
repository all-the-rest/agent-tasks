import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createDatabase, executions, executionSources, providerCredentials, providers } from '@agent-tasks/database';
import { MODEL_VARIANTS, SecretBox } from '@agent-tasks/ai-providers';
import { afterAll, describe, expect, it } from 'vitest';
import { OpenCodeV2Client } from '../src/opencode-v2-client.js';
import { createOpenCodeV2Runner } from '../src/opencode-v2-runner.js';
import { createIsolatedOpenCodeRunner } from '../src/opencode-isolated-runtime.js';
import { createToolBridgeHub } from '../src/opencode-tool-bridge.js';
import type { OpenCodeSessionStore } from '../src/opencode-session-store.js';
import { Executor } from '../src/executor.js';
import { createProvisionerServer, runtimeConfig } from '../../../services/opencode-provisioner/server.mjs';
import type { WorkerEnv } from '../src/env.js';
import { createBoss, executionWorkOptions, QUEUE_EXECUTION } from '../src/queues.js';
import { AGENT_RUNTIME_LIMITS } from '@agent-tasks/shared';

// Opt in explicitly: this starts a real OpenCode binary, not a mocked client.
describe.skipIf(process.env.OPENCODE_LIVE_TEST !== '1')('OpenCode V2 with an OpenAI-compatible mock', () => {
  let child: ChildProcess | undefined;
  let directory: string | undefined;
  const mock = createServer();
  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (mock.listening) await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('authenticates, creates a session, sends a prompt, and reads the mock answer', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-tasks-opencode-test-'));
    const config = join(directory, 'config', 'opencode');
    await mkdir(config, { recursive: true });
    const requests: string[] = [];
    mock.on('request', (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'mock integration answer' }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    mock.listen(0, '127.0.0.1');
    await once(mock, 'listening');
    const mockAddress = mock.address();
    if (!mockAddress || typeof mockAddress === 'string') throw new Error('mock port unavailable');
    const reservation = createNetServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const serverAddress = reservation.address();
    if (!serverAddress || typeof serverAddress === 'string') throw new Error('server port unavailable');
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    await writeFile(join(config, 'opencode.json'), JSON.stringify({
      update: 'disable',
      model: 'mock/mock-model',
      providers: { mock: { name: 'Mock', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${mockAddress.port}/v1`, apiKey: 'fake-key' }, models: { 'mock-model': { name: 'Mock Model', limit: { context: 32000, output: 1024 } } } } },
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    }));
    const password = 'local-test-only';
    child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(serverAddress.port)], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'), OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stderr?.on('data', (data: Buffer) => { logs += data.toString(); });
    const baseUrl = `http://127.0.0.1:${serverAddress.port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`OpenCode exited: ${logs}`);
      try {
        const response = await fetch(`${baseUrl}/api/info`, { headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` } });
        if (response.ok) { ready = true; break; }
      } catch { /* server is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ready, logs).toBe(true);
    expect((await fetch(`${baseUrl}/api/info`)).status).toBe(401);
    const client = new OpenCodeV2Client({ baseUrl, password });
    const session = await client.createSession({ directory, model: { providerID: 'mock', id: 'mock-model' } });
    await client.prompt(session.id, 'msg_00000000000000000000000001', 'Respond to this test.');
    let messages: unknown;
    for (let attempt = 0; attempt < 150; attempt++) {
      messages = await client.getMessages(session.id);
      if (JSON.stringify(messages).includes('mock integration answer')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(JSON.stringify(messages), logs).toContain('mock integration answer');
    expect(requests.some((request) => request.includes('/chat/completions'))).toBe(true);

    // Exercise the real Executor and OpenCode runner with a fake persistence layer.
    // PostgreSQL admission and durability are covered separately by integration tests.
    const executionId = randomUUID();
    const ownerId = 'live-test-owner';
    const key = Buffer.alloc(32, 1).toString('base64');
    const task = { id: randomUUID(), ownerId, providerId: randomUUID(), title: 'Mock task', prompt: 'Respond to this test.', model: 'mock-model', timezone: 'UTC', allowWebResearch: false, notification: 'none', memorySettings: { mode: 'off' } };
    const provider = { id: task.providerId, name: 'Mock', kind: 'openai-compatible', enabled: true, config: { baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`, models: [{ id: 'mock-model', supportsTools: false }] } };
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const dialect = new PgDialect();
    const execute = async (query: unknown) => {
      const sql = typeof query === 'string' ? query : dialect.sqlToQuery(query as never).sql;
      if (sql.includes('system_settings')) return { rows: [{ values: {} }] };
      if (sql.includes('select owner_id, attempt')) return { rows: [{ owner_id: ownerId, attempt: 0, already_admitted_today: false }] };
      if (sql.includes('pg_advisory_xact_lock') || sql.includes('update executions')) return { rows: [] };
      if (sql.includes('prior_executions_today')) return { rows: [{ prior_executions_today: 0, other_running_for_owner: 0 }] };
      if (sql.includes('select cancel_requested')) return { rows: [{ cancel_requested: false }] };
      throw new Error(`unexpected SQL: ${sql}`);
    };
    const db = {
      execute,
      transaction: async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => callback({ execute }),
      select: () => ({ from: (table: unknown) => {
        const value = table === providers ? [provider] : table === executions ? [{ execution: { id: executionId, ownerId, attempt: 0 }, task }] : table === providerCredentials ? [{ ownerId: null, ciphertext: new SecretBox(key).encrypt('fake-key') }] : [];
        const chain = { innerJoin: () => chain, where: () => chain, limit: async () => value, then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(value).then(resolve, reject) };
        return chain;
      } }),
      update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push({ table, values }); } }) }),
      delete: () => ({ where: async () => undefined }),
      insert: () => ({ values: async () => undefined }),
    };
    const env = {
      NODE_ENV: 'test', DATABASE_URL: 'postgres://unused', SECRETS_ENCRYPTION_KEY: key,
      RUNNER_URL: 'http://127.0.0.1:1', RUNNER_TOKEN: 'live-test-runner-token', WORKER_CONCURRENCY: 1,
      LOG_LEVEL: 'silent', PUBLIC_BASE_URL: 'http://localhost:8080',
      OPENCODE_PROVISIONER_URL: 'http://127.0.0.1:4090', OPENCODE_PROVISIONER_TOKEN: 'live-test-provisioner-token-0123456789',
    } satisfies WorkerEnv;
    const runner = createOpenCodeV2Runner({ client, directory, model: { providerID: 'mock', id: 'mock-model' } });
    const executor = new Executor({ db: db as never, env, boss: {} as never, workerId: 'live-test-worker', openCodeRunner: runner });
    await executor.handle(executionId);
    expect(updates.find((update) => update.table === executions && update.values.status === 'completed')?.values.report, JSON.stringify(updates.map((update) => update.values)))
      .toMatchObject({ markdown: 'mock integration answer' });

    // Explicit opt-in: only use an operator-provided dedicated, migrated test DB.
    const databaseUrl = process.env.OPENCODE_TEST_DATABASE_URL;
    if (databaseUrl) {
      const database = createDatabase(databaseUrl);
      const boss = await createBoss(databaseUrl);
      const realOwnerId = randomUUID();
      const realTaskId = randomUUID();
      const realProviderId = randomUUID();
      const realExecutionId = randomUUID();
      try {
        await database.pool.query(`insert into "user" (id, name, email, email_verified, role) values ($1,'OpenCode test',$2,true,'USER')`, [realOwnerId, `${realOwnerId}@example.invalid`]);
        await database.pool.query(`insert into providers (id, name, kind, enabled, is_default, config) values ($1,$2,'openai-compatible',true,false,$3)`, [realProviderId, `OpenCode test ${realProviderId}`, JSON.stringify(provider.config)]);
        await database.pool.query(`insert into provider_credentials (id, provider_id, owner_id, label, ciphertext) values ($1,$2,$3,'test',$4)`, [randomUUID(), realProviderId, realOwnerId, new SecretBox(key).encrypt('fake-key')]);
        await database.pool.query(`insert into tasks (id, owner_id, title, prompt, provider_id, model, enabled, schedule, timezone, limits, allow_web_research, notification, memory_settings) values ($1,$2,'Mock task','Respond to this test.',$3,'mock-model',true,$4,'UTC',$5,false,'none',$6)`, [realTaskId, realOwnerId, realProviderId, JSON.stringify({ preset: 'daily', timezone: 'UTC', hour: 6, minute: 0 }), JSON.stringify(AGENT_RUNTIME_LIMITS), JSON.stringify({ mode: 'off' })]);
        await database.pool.query(`insert into executions (id, task_id, owner_id, task_title, status, trigger, model, provider_id) values ($1,$2,$3,'Mock task','queued','manual','mock-model',$4)`, [realExecutionId, realTaskId, realOwnerId, realProviderId]);
        const realExecutor = new Executor({ db: database.db, env: { ...env, DATABASE_URL: databaseUrl }, boss, workerId: 'live-postgres-worker', openCodeRunner: runner });
        await boss.work<{ executionId: string }>(QUEUE_EXECUTION, executionWorkOptions(1), async (jobs) => {
          for (const job of jobs) await realExecutor.handle(job.data.executionId);
        });
        await boss.send(QUEUE_EXECUTION, { executionId: realExecutionId });
        let row: { status: string; report: unknown; error: string | null } | undefined;
        for (let attempt = 0; attempt < 200; attempt++) {
          const result = await database.pool.query<{ status: string; report: unknown; error: string | null }>('select status, report, error from executions where id = $1', [realExecutionId]);
          row = result.rows[0];
          if (row?.status === 'completed' || row?.status === 'failed') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(row).toMatchObject({ status: 'completed', error: null, report: { markdown: 'mock integration answer' } });
        console.log('PostgreSQL + pg-boss + Executor + OpenCode + mock provider: completed and report persisted');
      } finally {
        await boss.stop();
        await database.close();
      }
    }
  }, 40_000);

  it('calls the bridged e-mail tool through the provisioner proxy with a fake model', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-tasks-opencode-mcp-'));
    const config = join(workspace, 'config', 'opencode');
    await mkdir(config, { recursive: true });
    const chat = createServer();
    let sawTool = false;
    chat.on('request', (request, response) => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      let raw = '';
      request.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      request.on('end', () => {
        const body = JSON.parse(raw) as { model: string; tools?: Array<{ function?: { name?: string }; name?: string }>; messages?: Array<{ role?: string }> };
        const names = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
        const target = names.find((name) => typeof name === 'string' && name.endsWith('compose_email'));
        const hasToolResult = (body.messages ?? []).some((message) => message.role === 'tool');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = (delta: object, finish: string | null = null) => response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-mcp', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
        emit({ role: 'assistant', content: '' });
        if (target && !hasToolResult) {
          sawTool = true;
          emit({ tool_calls: [{ index: 0, id: 'call_mcp_1', type: 'function', function: { name: target, arguments: JSON.stringify({ dsl: '# Live report\n\nBridge works.' }) } }] }, 'tool_calls');
        } else {
          emit({ content: 'MCP FINAL ANSWER' });
          emit({}, 'stop');
        }
        response.end('data: [DONE]\n\n');
      });
    });
    chat.listen(0, '127.0.0.1');
    await once(chat, 'listening');
    const chatAddress = chat.address();
    if (!chatAddress || typeof chatAddress === 'string') throw new Error('chat port unavailable');
    const reservation = createNetServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const serverAddress = reservation.address();
    if (!serverAddress || typeof serverAddress === 'string') throw new Error('server port unavailable');
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

    const hub = await createToolBridgeHub({ port: 0 });
    const session = hub.open({ tools: ['compose_email'] });
    const previousBridgeUrl = process.env.TOOL_BRIDGE_URL;
    process.env.TOOL_BRIDGE_URL = hub.url;
    const proxy = createProvisionerServer({ token: 'local-test-provisioner-token-1234567890' });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('proxy port unavailable');
    let proc: ChildProcess | undefined;
    try {
      const openCodeConfig = JSON.stringify({
        update: 'disable',
        model: 'agent_tasks/mock-model',
        plugins: [],
        mcp: {
          servers: {
            agent_tasks_tools: {
              type: 'remote',
              url: `http://127.0.0.1:${proxyAddress.port}/mcp`,
              headers: { authorization: `Bearer ${session.token}` },
              codemode: false,
              timeout: { startup: 10_000, catalog: 10_000, execution: 30_000 },
            },
          },
        },
        default_agent: 'agent-tasks',
        policies: [
          { action: 'mcp.use', resource: 'agent_tasks_tools', effect: 'allow' },
          { action: 'provider.use', resource: 'agent_tasks', effect: 'allow' },
        ],
        agents: {
          'agent-tasks': {
            description: 'Live bridge test',
            mode: 'primary',
            steps: 10,
            system: 'Call compose_email once, then answer.',
            permissions: [
              { action: '*', resource: '*', effect: 'deny' },
              { action: 'agent_tasks_tools_compose_email', resource: '*', effect: 'allow' },
            ],
          },
        },
        providers: {
          agent_tasks: {
            name: 'Mock',
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: `http://127.0.0.1:${chatAddress.port}/v1`, apiKey: 'fake-key' },
            models: { 'mock-model': { name: 'Mock Model', tool_call: true, limit: { context: 32_000, output: 1_024 } } },
          },
        },
      });
      await writeFile(join(config, 'opencode.json'), openCodeConfig);
      const password = 'local-test-only';
      proc = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(serverAddress.port)], {
        cwd: workspace,
        env: { PATH: process.env.PATH, HOME: workspace, XDG_CONFIG_HOME: join(workspace, 'config'), XDG_DATA_HOME: join(workspace, 'data'), XDG_CACHE_HOME: join(workspace, 'cache'), OPENCODE_SERVER_PASSWORD: password },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let logs = '';
      proc.stderr?.on('data', (data: Buffer) => { logs += data.toString(); });
      const baseUrl = `http://127.0.0.1:${serverAddress.port}`;
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (proc.exitCode !== null) throw new Error(`OpenCode exited: ${logs}`);
        try {
          if ((await fetch(`${baseUrl}/api/info`, { headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` } })).ok) { ready = true; break; }
        } catch { /* server is starting */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready, logs).toBe(true);

      const client = new OpenCodeV2Client({ baseUrl, password });
      const mappings = new Map<string, { sessionId: string; messageId: string; promptDispatched: boolean }>();
      const store = {
        access: async (lease: { executionId: string }, candidate?: { sessionId: string; messageId: string; promptDispatched: boolean }) => {
          if (candidate && !mappings.has(lease.executionId)) mappings.set(lease.executionId, candidate);
          return mappings.get(lease.executionId) ?? null;
        },
        claimPrompt: async () => true,
      } as unknown as OpenCodeSessionStore;
      // The runtime config carries the token of `session`; the runner must use
      // that same pre-opened session so the tool result lands in our result.
      const testHub = { url: hub.url, open: () => session, close: async () => undefined };
      const runner = createIsolatedOpenCodeRunner({
        open: async () => ({ client, directory: workspace, model: { providerID: 'agent_tasks', id: 'mock-model' }, release: async () => undefined }),
      }, store, testHub);
      const result = await runner({
        provider: { kind: 'openai-compatible' },
        providerContext: { apiKey: 'fake-key', config: { models: [{ id: 'mock-model', label: 'Mock Model', supportsTools: true }] } },
        model: 'mock-model',
        title: 'Bridge test',
        prompt: 'Compose the e-mail.',
        timezone: 'UTC',
        allowWebResearch: false,
        allowForms: false,
        emailNotification: true,
        limits: AGENT_RUNTIME_LIMITS,
      } as never, { executionId: randomUUID(), ownerId: randomUUID(), workerId: 'live-bridge-worker' });
      expect(sawTool, logs).toBe(true);
      expect(result.markdown).toBe('MCP FINAL ANSWER');
      expect(result.emailBlocks.map((block) => block.type)).toEqual(['heading', 'paragraph']);
    } finally {
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM');
        await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
      await hub.close();
      await new Promise<void>((resolve, reject) => proxy.close((error: Error | undefined) => error ? reject(error) : resolve()));
      if (previousBridgeUrl === undefined) delete process.env.TOOL_BRIDGE_URL;
      else process.env.TOOL_BRIDGE_URL = previousBridgeUrl;
      await new Promise<void>((resolve, reject) => chat.close((error) => error ? reject(error) : resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it('retrieves a source through the bridge and persists it for the execution', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-tasks-opencode-research-'));
    const config = join(workspace, 'config', 'opencode');
    await mkdir(config, { recursive: true });
    const chat = createServer();
    let sawTool = false;
    chat.on('request', (request, response) => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      let raw = '';
      request.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      request.on('end', () => {
        const body = JSON.parse(raw) as { model: string; tools?: Array<{ function?: { name?: string }; name?: string }>; messages?: Array<{ role?: string }> };
        const names = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
        const target = names.find((name) => typeof name === 'string' && name.endsWith('open_url'));
        const hasToolResult = (body.messages ?? []).some((message) => message.role === 'tool');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = (delta: object, finish: string | null = null) => response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-research', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
        emit({ role: 'assistant', content: '' });
        if (target && !hasToolResult) {
          sawTool = true;
          emit({ tool_calls: [{ index: 0, id: 'call_research_1', type: 'function', function: { name: target, arguments: JSON.stringify({ url: 'https://example.com/live-report' }) } }] }, 'tool_calls');
        } else {
          emit({ content: 'RESEARCH FINAL ANSWER' });
          emit({}, 'stop');
        }
        response.end('data: [DONE]\n\n');
      });
    });
    chat.listen(0, '127.0.0.1');
    await once(chat, 'listening');
    const chatAddress = chat.address();
    if (!chatAddress || typeof chatAddress === 'string') throw new Error('chat port unavailable');

    // The Executor creates a browser session when research is enabled. This stub
    // owns the session; the bridge's open_url call uses the same fake capability.
    const browserRunner = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ sessionId: 'live-browser-session' }));
      });
    });
    browserRunner.listen(0, '127.0.0.1');
    await once(browserRunner, 'listening');
    const runnerAddress = browserRunner.address();
    if (!runnerAddress || typeof runnerAddress === 'string') throw new Error('runner port unavailable');

    const reservation = createNetServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const serverAddress = reservation.address();
    if (!serverAddress || typeof serverAddress === 'string') throw new Error('server port unavailable');
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

    const hub = await createToolBridgeHub({ port: 0 });
    const session = hub.open({
      tools: ['open_url'],
      context: {
        browser: {
          act: async () => ({ ok: true, action: 'open_url', url: 'https://example.com/live-report', title: 'Live report', text: 'Research evidence.' }),
        } as never,
        search: { search: async () => [] },
        sessionId: 'live-browser-session',
        allowForms: false,
        limits: { maxPageVisits: 5, maxSearchQueries: 5, maxOutputBytes: 8_192 },
      },
    });
    let proc: ChildProcess | undefined;
    try {
      // Use the provisioner's real runtime config so the live test proves the
      // production shape (policies, namespaced permission allows, tool_call and
      // the env-referenced API key), not a hand-written approximation.
      const openCodeConfig = runtimeConfig({
        lease: { executionId: randomUUID(), ownerId: randomUUID(), workerId: 'live-research-worker' },
        providerKind: 'openai-compatible',
        provider: {
          baseUrl: `http://127.0.0.1:${chatAddress.port}/v1`,
          models: [{ id: 'mock-model', label: 'Mock Model', supportsTools: true, contextLength: 32_000 }],
          headers: {},
          sessionHeader: 'x-opencode-session',
          timeoutMs: 30_000,
        },
        model: { providerID: 'agent_tasks', id: 'mock-model' },
        apiKey: 'fake-key',
        systemPrompt: 'Open the page once, then answer.',
        maxAgentSteps: 10,
        maxOutputBytes: 8_192,
        toolBridge: { token: session.token, tools: ['open_url'] },
      }, `http://127.0.0.1:${chatAddress.port}/v1`);
      // The provisioner normally proxies /mcp; point the server entry at the hub
      // directly, which is the only change from the production config.
      openCodeConfig.mcp.servers.agent_tasks_tools.url = hub.url;
      openCodeConfig.mcp.servers.agent_tasks_tools.timeout.execution = 30_000;
      await writeFile(join(config, 'opencode.json'), JSON.stringify(openCodeConfig));
      const password = 'local-test-only';
      proc = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(serverAddress.port)], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH, HOME: workspace, XDG_CONFIG_HOME: join(workspace, 'config'),
          XDG_DATA_HOME: join(workspace, 'data'), XDG_CACHE_HOME: join(workspace, 'cache'),
          OPENCODE_SERVER_PASSWORD: password,
          AGENT_TASKS_API_KEY: 'fake-key',
          AGENT_TASKS_EGRESS_TOKEN: 'test-egress-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let logs = '';
      proc.stderr?.on('data', (data: Buffer) => { logs += data.toString(); });
      const baseUrl = `http://127.0.0.1:${serverAddress.port}`;
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (proc.exitCode !== null) throw new Error(`OpenCode exited: ${logs}`);
        try {
          if ((await fetch(`${baseUrl}/api/info`, { headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` } })).ok) { ready = true; break; }
        } catch { /* server is starting */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready, logs).toBe(true);

      const client = new OpenCodeV2Client({ baseUrl, password });
      const mappings = new Map<string, { sessionId: string; messageId: string; promptDispatched: boolean }>();
      const store = {
        access: async (lease: { executionId: string }, candidate?: { sessionId: string; messageId: string; promptDispatched: boolean }) => {
          if (candidate && !mappings.has(lease.executionId)) mappings.set(lease.executionId, candidate);
          return mappings.get(lease.executionId) ?? null;
        },
        claimPrompt: async () => true,
      } as unknown as OpenCodeSessionStore;
      const testHub = { url: hub.url, open: () => session, close: async () => undefined };
      const openCodeRunner = createIsolatedOpenCodeRunner({
        open: async () => ({ client, directory: workspace, model: { providerID: 'agent_tasks', id: 'mock-model' }, release: async () => undefined }),
      }, store, testHub);

      // The persistence seam captures the real insert the Executor performs.
      const executionId = randomUUID();
      const ownerId = 'live-research-owner';
      const key = Buffer.alloc(32, 1).toString('base64');
      const task = {
        id: randomUUID(), ownerId, providerId: randomUUID(), title: 'Research task', prompt: 'Open the page.',
        model: 'mock-model', timezone: 'UTC', allowWebResearch: true, notification: 'none', memorySettings: { mode: 'off' },
      };
      const provider = { id: task.providerId, name: 'Mock', kind: 'openai-compatible', enabled: true, config: { baseUrl: `http://127.0.0.1:${chatAddress.port}/v1`, models: [{ id: 'mock-model', supportsTools: true }] } };
      const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
      const insertedSources: Array<Record<string, unknown>> = [];
      const dialect = new PgDialect();
      const execute = async (query: unknown) => {
        const sql = typeof query === 'string' ? query : dialect.sqlToQuery(query as never).sql;
        if (sql.includes('system_settings')) return { rows: [{ values: {} }] };
        if (sql.includes('select owner_id, attempt')) return { rows: [{ owner_id: ownerId, attempt: 0, already_admitted_today: false }] };
        if (sql.includes('pg_advisory_xact_lock') || sql.includes('update executions')) return { rows: [] };
        if (sql.includes('prior_executions_today')) return { rows: [{ prior_executions_today: 0, other_running_for_owner: 0 }] };
        if (sql.includes('select cancel_requested')) return { rows: [{ cancel_requested: false }] };
        throw new Error(`unexpected SQL: ${sql}`);
      };
      const db = {
        execute,
        transaction: async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => callback({ execute }),
        select: () => ({ from: (table: unknown) => {
          const value = table === providers ? [provider] : table === executions ? [{ execution: { id: executionId, ownerId, attempt: 0 }, task }] : table === providerCredentials ? [{ ownerId: null, ciphertext: new SecretBox(key).encrypt('fake-key') }] : [];
          const chain = { innerJoin: () => chain, where: () => chain, limit: async () => value, then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(value).then(resolve, reject) };
          return chain;
        } }),
        update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { updates.push({ table, values }); } }) }),
        delete: () => ({ where: async () => undefined }),
        insert: (table: unknown) => ({ values: async (rows: unknown) => { if (table === executionSources) insertedSources.push(...(rows as Array<Record<string, unknown>>)); } }),
      };
      const env = {
        NODE_ENV: 'test', DATABASE_URL: 'postgres://unused', SECRETS_ENCRYPTION_KEY: key,
        RUNNER_URL: `http://127.0.0.1:${runnerAddress.port}`, RUNNER_TOKEN: 'live-test-runner-token',
        WORKER_CONCURRENCY: 1, LOG_LEVEL: 'silent',
        PUBLIC_BASE_URL: 'http://localhost:8080',
        OPENCODE_PROVISIONER_URL: 'http://127.0.0.1:4090',
        OPENCODE_PROVISIONER_TOKEN: 'live-test-provisioner-token-0123456789',
      } satisfies WorkerEnv;
      const executor = new Executor({ db: db as never, env, boss: {} as never, workerId: 'live-research-worker', openCodeRunner });
      await executor.handle(executionId);
      const usage = updates.find((update) => update.table === executions && update.values.status === 'completed')?.values.usage;
      // The mock provider emits no usage counters, so the runner must not invent
      // tokens; real providers populate the per-turn values that are summed.
      expect(usage).toEqual({});

      expect(sawTool, logs).toBe(true);
      expect(updates.find((update) => update.table === executions && update.values.status === 'completed')?.values.report)
        .toMatchObject({ markdown: 'RESEARCH FINAL ANSWER', sources: [{ url: 'https://example.com/live-report', title: 'Live report', confidence: 'verified' }] });
      expect(insertedSources).toEqual([
        expect.objectContaining({ executionId, url: 'https://example.com/live-report', title: 'Live report', confidence: 'verified' }),
      ]);
    } finally {
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM');
        await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
      await hub.close();
      await new Promise<void>((resolve, reject) => chat.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => browserRunner.close((error) => error ? reject(error) : resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it('maps every model variant to its reasoning effort through the provisioner runtime config', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-tasks-opencode-variants-'));
    const config = join(workspace, 'config', 'opencode');
    await mkdir(config, { recursive: true });
    const chat = createServer();
    const requests: Array<{ messages?: Array<{ role?: string; content?: unknown }>; reasoning_effort?: string }> = [];
    chat.on('request', (request, response) => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      let raw = '';
      request.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      request.on('end', () => {
        requests.push(JSON.parse(raw) as typeof requests[number]);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ id: 'variant', object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'variant answer' }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: 'variant', object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    chat.listen(0, '127.0.0.1');
    await once(chat, 'listening');
    const chatAddress = chat.address();
    if (!chatAddress || typeof chatAddress === 'string') throw new Error('chat port unavailable');
    const reservation = createNetServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const serverAddress = reservation.address();
    if (!serverAddress || typeof serverAddress === 'string') throw new Error('server port unavailable');
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

    let proc: ChildProcess | undefined;
    let logs = '';
    try {
      // The provisioner's real runtime config declares every variant; this proves
      // OpenCode 2.2.5 accepts the declarations and maps each one to reasoning_effort.
      const openCodeConfig = runtimeConfig({
        lease: { executionId: randomUUID(), ownerId: randomUUID(), workerId: 'live-variant-worker' },
        providerKind: 'openai-compatible',
        provider: {
          baseUrl: `http://127.0.0.1:${chatAddress.port}/v1`,
          models: [{ id: 'mock-model', label: 'Mock Model', supportsTools: false }],
          headers: {},
          sessionHeader: 'x-opencode-session',
          timeoutMs: 30_000,
        },
        model: { providerID: 'agent_tasks', id: 'mock-model' },
        apiKey: 'fake-key',
        systemPrompt: 'Answer briefly.',
        maxAgentSteps: 2,
        maxOutputBytes: 4_096,
      }, `http://127.0.0.1:${chatAddress.port}/v1`);
      await writeFile(join(config, 'opencode.json'), JSON.stringify(openCodeConfig));
      const password = 'local-test-only';
      proc = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(serverAddress.port)], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH, HOME: workspace, XDG_CONFIG_HOME: join(workspace, 'config'),
          XDG_DATA_HOME: join(workspace, 'data'), XDG_CACHE_HOME: join(workspace, 'cache'),
          OPENCODE_SERVER_PASSWORD: password,
          AGENT_TASKS_API_KEY: 'fake-key',
          AGENT_TASKS_EGRESS_TOKEN: 'test-egress-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stderr?.on('data', (data: Buffer) => { logs += data.toString(); });
      const baseUrl = `http://127.0.0.1:${serverAddress.port}`;
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (proc.exitCode !== null) throw new Error(`OpenCode exited: ${logs}`);
        try {
          if ((await fetch(`${baseUrl}/api/info`, { headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` } })).ok) { ready = true; break; }
        } catch { /* server is starting */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready, logs).toBe(true);

      const client = new OpenCodeV2Client({ baseUrl, password });
      let seq = 0;
      for (const variant of MODEL_VARIANTS) {
        const prompt = `variant probe ${variant}`;
        requests.length = 0;
        const session = await client.createSession({ directory: workspace, model: { providerID: 'agent_tasks', id: 'mock-model', variant } });
        await client.prompt(session.id, `msg_${String(seq++).padStart(26, '0')}`, prompt);
        let messages: unknown;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          messages = await client.getMessages(session.id);
          if (JSON.stringify(messages).includes('variant answer')) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const transcript = JSON.stringify(messages);
        expect(transcript, `${variant}: ${logs}`).toContain('variant answer');
        expect(transcript).not.toContain('"outcome":"failed"');
        const main = requests.find((body) =>
          (body.messages ?? []).some((message) => message.role === 'user' && message.content === prompt));
        expect(main?.reasoning_effort, `${variant} reasoning effort (${logs})`).toBe(variant);
      }
    } finally {
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM');
        await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
      await new Promise<void>((resolve, reject) => chat.close((error: Error | undefined) => error ? reject(error) : resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
  }, 90_000);
});
