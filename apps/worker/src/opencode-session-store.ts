import { sql } from 'drizzle-orm';
import type { Database } from '@agent-tasks/database';

export interface OpenCodeExecutionLease {
  executionId: string;
  ownerId: string;
  workerId: string;
}

export interface OpenCodeSessionMapping {
  sessionId: string;
  messageId: string;
  promptDispatched: boolean;
}

/** Internal-only mapping, protected by the execution's owner and active lease. */
export class OpenCodeSessionStore {
  constructor(private readonly db: Database) {}

  async access(lease: OpenCodeExecutionLease, candidate?: OpenCodeSessionMapping): Promise<OpenCodeSessionMapping | null> {
    return this.db.transaction(async (tx) => {
      const owned = await tx.execute(sql`
        select id from executions where id = ${lease.executionId} and owner_id = ${lease.ownerId}
          and worker_id = ${lease.workerId} and status = 'running'
          and lease_expires_at > now() and not cancel_requested for update
      `);
      if (!owned.rows[0]) throw new Error('OpenCode execution lease unavailable');
      if (candidate) {
        await tx.execute(sql`
          insert into execution_opencode_sessions (execution_id, session_id, message_id)
          values (${lease.executionId}, ${candidate.sessionId}, ${candidate.messageId})
          on conflict (execution_id) do nothing
        `);
      }
      const result = await tx.execute<{ session_id: string; message_id: string; prompt_dispatched: boolean }>(sql`
        select session_id, message_id, prompt_dispatched from execution_opencode_sessions
        where execution_id = ${lease.executionId}
      `);
      const row = result.rows[0];
      return row ? { sessionId: row.session_id, messageId: row.message_id, promptDispatched: row.prompt_dispatched } : null;
    });
  }

  /** Claim once before sending: recovery must never retry an ambiguous dispatch. */
  async claimPrompt(lease: OpenCodeExecutionLease): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const owned = await tx.execute(sql`
        select id from executions where id = ${lease.executionId} and owner_id = ${lease.ownerId}
          and worker_id = ${lease.workerId} and status = 'running'
          and lease_expires_at > now() and not cancel_requested for update
      `);
      if (!owned.rows[0]) throw new Error('OpenCode execution lease unavailable');
      const claimed = await tx.execute(sql`
        update execution_opencode_sessions set prompt_dispatched = true
        where execution_id = ${lease.executionId} and not prompt_dispatched returning execution_id
      `);
      return !!claimed.rows[0];
    });
  }
}
