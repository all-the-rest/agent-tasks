export const CONVERSATION_CONTEXT_TURNS = 4;
export const CONVERSATION_TURN_MAX_BYTES = 8_000;
export const CONVERSATION_CONTEXT_MAX_BYTES = 24_000;
export const CONVERSATION_DISPLAY_MAX_BYTES = 12_000;

export interface ConversationTurnInput {
  id: string;
  status: string;
  inputSnapshot: string;
  assistantOutput: string | null;
}

export interface ConversationTurn {
  user: string;
  assistant: string;
}

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Truncates at a Unicode code-point boundary while respecting the UTF-8 byte cap. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function boundedTurn(turn: ConversationTurnInput): ConversationTurn {
  let user = truncateUtf8(turn.inputSnapshot, CONVERSATION_TURN_MAX_BYTES / 2);
  let assistant = truncateUtf8(turn.assistantOutput ?? '', CONVERSATION_TURN_MAX_BYTES / 2);
  let candidate = { user, assistant };
  while (utf8Bytes(JSON.stringify(candidate)) > CONVERSATION_TURN_MAX_BYTES) {
    const assistantBytes = utf8Bytes(assistant);
    const userBytes = utf8Bytes(user);
    if (assistantBytes >= userBytes && assistantBytes > 0) {
      assistant = truncateUtf8(assistant, Math.floor(assistantBytes * 0.75));
    } else if (userBytes > 0) {
      user = truncateUtf8(user, Math.floor(userBytes * 0.75));
    } else {
      break;
    }
    candidate = { user, assistant };
  }
  return candidate;
}

/** Builds chronological, completed-only context with strict serialized byte caps. */
export function buildConversationContext(turns: ConversationTurnInput[], currentExecutionId: string): string {
  const completed = turns
    .filter((turn) => turn.status === 'completed' && turn.id !== currentExecutionId && turn.inputSnapshot.length > 0)
    .slice(0, CONVERSATION_CONTEXT_TURNS);

  const recentFirst: ConversationTurn[] = [];
  for (const turn of completed) {
    let candidate = boundedTurn(turn);
    let proposed = [...recentFirst, candidate];
    while (utf8Bytes(JSON.stringify(proposed)) > CONVERSATION_CONTEXT_MAX_BYTES) {
      if (utf8Bytes(candidate.assistant) > 0) {
        candidate = { ...candidate, assistant: truncateUtf8(candidate.assistant, Math.floor(utf8Bytes(candidate.assistant) * 0.75)) };
      } else if (utf8Bytes(candidate.user) > 0) {
        candidate = { ...candidate, user: truncateUtf8(candidate.user, Math.floor(utf8Bytes(candidate.user) * 0.75)) };
      } else {
        break;
      }
      proposed = [...recentFirst, candidate];
    }
    if (utf8Bytes(JSON.stringify(proposed)) <= CONVERSATION_CONTEXT_MAX_BYTES) recentFirst.push(candidate);
  }
  return JSON.stringify(recentFirst.reverse());
}
