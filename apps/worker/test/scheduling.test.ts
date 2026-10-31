import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { executions } from '@agent-tasks/database';
import type { Database } from '@agent-tasks/database';
import { queuedExecutionPage, resendQueuedExecutions } from '../src/scheduling.js';

interface Row {
  id: string;
  updated_at: Date;
  status: string;
}

interface UpdateRecord {
  id: string;
  values: Record<string, unknown>;
}

/**
 * In-memory stand-in for the two queries the sweep uses: the keyset page select and the
 * `updated_at` bump after a successful send. `sqlToQuery` exposes the interpolated params,
 * so the same order as `queuedExecutionPage` drives the filter.
 */
function fakeDb(rows: Row[], currentTime: () => number = Date.now) {
  const dialect = new PgDialect();
  const updates: UpdateRecord[] = [];

  const execute = async (query: unknown) => {
    const { sql, params } = dialect.sqlToQuery(query as never);
    if (!sql.includes('from executions')) throw new Error(`unexpected SQL: ${sql}`);
    const olderThanSeconds = Number(params[0]);
    const pageSize = Number(params[params.length - 1]);
    const cutoff = currentTime() - olderThanSeconds * 1_000;
    const hasCursor = params.length === 4;
    const afterTime = hasCursor ? new Date(String(params[1])).getTime() : null;
    const afterId = hasCursor ? String(params[2]) : null;

    const selected = rows
      .filter((row) => row.status === 'queued' && row.updated_at.getTime() <= cutoff)
      .filter((row) => {
        if (afterTime === null) return true;
        const time = row.updated_at.getTime();
        return time > afterTime || (time === afterTime && row.id > (afterId ?? ''));
      })
      .sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, pageSize);

    return { rows: selected.map((row) => ({ id: row.id, updated_at: row.updated_at })) };
  };

  const update = (table: unknown) => ({
    set(values: Record<string, unknown>) {
      return {
        where: async (condition: unknown) => {
          if (table !== executions) throw new Error('unexpected update table');
          const { params } = dialect.sqlToQuery(condition as never);
          const id = String(params[0]);
          updates.push({ id, values });
          const row = rows.find((candidate) => candidate.id === id);
          if (row && values.updatedAt instanceof Date) row.updated_at = values.updatedAt;
        },
      };
    },
  });

  return { db: { execute, update } as unknown as Database, rows, updates };
}

function makeRows(input: Array<{ id: string; ageSeconds: number; status?: string }>): Row[] {
  return input.map(({ id, ageSeconds, status = 'queued' }) => ({
    id,
    status,
    updated_at: new Date(Date.now() - ageSeconds * 1_000),
  }));
}

describe('queued execution sweep', () => {
  it('selects every stale page, skips fresh and non-queued rows, and paginates past the first page', async () => {
    const stale = Array.from({ length: 250 }, (_, index) => ({
      id: `id-${String(index).padStart(4, '0')}`,
      ageSeconds: 3_600,
    }));
    const fresh = Array.from({ length: 5 }, (_, index) => ({ id: `fresh-${index}`, ageSeconds: 1 }));
    const completed = Array.from({ length: 5 }, (_, index) => ({ id: `done-${index}`, ageSeconds: 3_600, status: 'completed' }));
    const fake = fakeDb(makeRows([...stale, ...fresh, ...completed]));

    const sent: string[] = [];
    const result = await resendQueuedExecutions(fake.db, async (executionId) => {
      sent.push(executionId);
    }, { olderThanSeconds: 60, pageSize: 100 });

    expect(result).toEqual({ attempted: 250, failed: [] });
    expect(sent).toHaveLength(250);
    expect(new Set(sent).size).toBe(250);
    expect(sent[0]).toBe('id-0000');
    expect(sent.at(-1)).toBe('id-0249');
    expect(sent.some((id) => id.startsWith('fresh-') || id.startsWith('done-'))).toBe(false);
  });

  it('returns a cursor that pages beyond one page instead of stopping at 20', async () => {
    const fake = fakeDb(makeRows(Array.from({ length: 45 }, (_, index) => ({ id: `id-${String(index).padStart(3, '0')}`, ageSeconds: 3_600 }))));
    const first = await queuedExecutionPage(fake.db, { olderThanSeconds: 60, pageSize: 20 });
    expect(first.ids).toHaveLength(20);
    expect(first.cursor).not.toBeNull();
    const second = await queuedExecutionPage(fake.db, { olderThanSeconds: 60, pageSize: 20, after: first.cursor });
    expect(second.ids).toHaveLength(20);
    expect(second.ids[0]).toBe('id-020');
    const third = await queuedExecutionPage(fake.db, { olderThanSeconds: 60, pageSize: 20, after: second.cursor });
    expect(third.ids).toHaveLength(5);
  });

  it('retries a failed send on the next sweep while leaving already-sent rows alone', async () => {
    const fake = fakeDb(makeRows([
      { id: 'id-a', ageSeconds: 3_600 },
      { id: 'id-b', ageSeconds: 3_600 },
    ]));
    const attempts: Record<string, number> = {};
    let failuresLeft = 1;
    const send = async (executionId: string): Promise<void> => {
      attempts[executionId] = (attempts[executionId] ?? 0) + 1;
      if (executionId === 'id-a' && failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('pg-boss send failed');
      }
    };

    const first = await resendQueuedExecutions(fake.db, send, { olderThanSeconds: 60, pageSize: 100 });
    expect(first).toEqual({ attempted: 2, failed: ['id-a'] });

    const second = await resendQueuedExecutions(fake.db, send, { olderThanSeconds: 60, pageSize: 100 });
    expect(second).toEqual({ attempted: 1, failed: [] });
    expect(attempts['id-a']).toBe(2);
    expect(attempts['id-b']).toBe(1);
  });

  it('treats a boot sweep (zero minimum age) as the same code path and sends every queued row', async () => {
    const fake = fakeDb(makeRows([
      { id: 'id-new', ageSeconds: 0 },
      { id: 'id-old', ageSeconds: 3_600 },
    ]));
    const sent: string[] = [];
    const result = await resendQueuedExecutions(fake.db, async (executionId) => {
      sent.push(executionId);
    }, { olderThanSeconds: 0 });
    expect(result).toEqual({ attempted: 2, failed: [] });
    expect(sent.sort()).toEqual(['id-new', 'id-old']);
  });
});
