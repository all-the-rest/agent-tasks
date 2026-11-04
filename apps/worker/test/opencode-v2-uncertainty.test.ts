import { afterEach, describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@agent-tasks/database';
import type { RunAgentOptions } from '@agent-tasks/agent-runtime';
import { AGENT_RUNTIME_LIMITS } from '@agent-tasks/shared';
import { FakeOpenCodeProvisioner } from '../../../test/helpers/fake-opencode.js';
import type { OpenCodeExecutionLease, OpenCodeSessionMapping } from '../src/opencode-session-store.js';

const lease: OpenCodeExecutionLease = { executionId: 'execution-1', ownerId: 'owner-1', workerId: 'worker-1' };
const mapping: OpenCodeSessionMapping = { sessionId: 'ses_execution1', messageId: 'msg_1', promptDispatched: true };

/** Minimal persisted session mapping for the real session store. */
function sessionDatabase(initial: OpenCodeSessionMapping): Database {
  const state = { ...initial };
  const dialect = new PgDialect();
  const execute = async (query: unknown) => {
    const text = dialect.sqlToQuery(query as never).sql;
    if (text.includes('select id from executions')) return { rows: [{ id: lease.executionId }] };
    if (text.includes('insert into execution_opencode_sessions')) return { rows: [] };
    if (text.includes('select session_id, message_id, prompt_dispatched')) {
      return {
        rows: [{
          session_id: state.sessionId,
          message_id: state.messageId,
          prompt_dispatched: state.promptDispatched,
        }],
      };
    }
    if (text.includes('update execution_opencode_sessions set prompt_dispatched')) {
      if (state.promptDispatched) return { rows: [] };
      state.promptDispatched = true;
      return { rows: [{ execution_id: lease.executionId }] };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  return {
    transaction: async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) => callback({ execute }),
  } as unknown as Database;
}

function options(): RunAgentOptions {
  return {
    provider: { kind: 'openai-compatible' },
    providerContext: {
      apiKey: 'test',
      config: { models: [{ id: 'model', label: 'Model', supportsTools: true }] },
    },
    model: 'model',
    title: 'Task',
    prompt: 'Open the page.',
    timezone: 'UTC',
    allowWebResearch: true,
    allowForms: false,
    limits: AGENT_RUNTIME_LIMITS,
    browser: {
      act: async () => ({
        ok: true,
        action: 'open_url',
        url: 'https://example.com/page',
        title: 'Example',
        text: 'Evidence',
      }),
    } as never,
    search: { search: async () => [] } as never,
    sessionId: 'session-1',
  } as RunAgentOptions;
}

describe('OpenCode runner uncertainty with the fake provisioner', () => {
  let provisioner: FakeOpenCodeProvisioner | undefined;

  afterEach(async () => {
    await provisioner?.close();
    provisioner = undefined;
  });

  it('does not claim no research when the bridge ran a tool but the runtime emitted no tool parts', async () => {
    provisioner = new FakeOpenCodeProvisioner();
    await provisioner.start();
    provisioner.plans.set(lease.executionId, {
      openUrls: ['https://example.com/page'],
      answer: 'Findings\n\nThe fake runtime opened one page.',
    });
    const result = await provisioner.runner(sessionDatabase(mapping))(options(), lease);

    // The bridge is the source of truth for research: it did collect the page.
    expect(provisioner.toolCalls.map((call) => call.name)).toContain('open_url');
    expect(result.sources.map((source) => source.url)).toContain('https://example.com/page');
    expect(result.uncertainty).not.toContain('No web research was performed, so no source was verified.');
    expect(result.uncertainty).toEqual([
      'The runtime did not expose tool-call evidence, so it could not be confirmed whether web research was performed.',
    ]);
  });
});
