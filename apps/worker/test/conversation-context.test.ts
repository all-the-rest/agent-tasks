import { describe, expect, it } from 'vitest';
import {
  buildConversationContext,
  CONVERSATION_CONTEXT_MAX_BYTES,
  CONVERSATION_TURN_MAX_BYTES,
  utf8Bytes,
} from '@agent-tasks/shared';

describe('task conversation context', () => {
  it('uses only recent completed turns and excludes the current execution', () => {
    const context = buildConversationContext([
      { id: 'current', status: 'completed', inputSnapshot: 'current input', assistantOutput: 'current answer' },
      { id: 'newest', status: 'completed', inputSnapshot: 'newest question', assistantOutput: 'newest answer' },
      { id: 'failed', status: 'failed', inputSnapshot: 'failed question', assistantOutput: 'failed output' },
      { id: 'cancelled', status: 'cancelled', inputSnapshot: 'cancelled question', assistantOutput: 'cancelled output' },
      { id: 'older', status: 'completed', inputSnapshot: 'older question', assistantOutput: 'older answer' },
    ], 'current');

    expect(JSON.parse(context)).toEqual([
      { user: 'older question', assistant: 'older answer' },
      { user: 'newest question', assistant: 'newest answer' },
    ]);
    expect(context).not.toContain('current input');
    expect(context).not.toContain('failed question');
    expect(context).not.toContain('cancelled question');
  });

  it('enforces strict UTF-8 byte caps for each turn and the serialized context', () => {
    const context = buildConversationContext(
      Array.from({ length: 8 }, (_, index) => ({
        id: `turn-${index}`,
        status: 'completed',
        inputSnapshot: '🧭'.repeat(20_000),
        assistantOutput: '🔒'.repeat(20_000),
      })),
      'not-current',
    );
    const turns = JSON.parse(context) as Array<{ user: string; assistant: string }>;

    expect(turns).toHaveLength(4);
    expect(utf8Bytes(context)).toBeLessThanOrEqual(CONVERSATION_CONTEXT_MAX_BYTES);
    for (const turn of turns) {
      expect(utf8Bytes(JSON.stringify(turn))).toBeLessThanOrEqual(CONVERSATION_TURN_MAX_BYTES);
    }
  });
});
