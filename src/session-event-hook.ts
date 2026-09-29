import type { ModelMessage } from 'ai';
import type { z } from 'zod';
import { RedisAgentMemoryToolError, sanitizeMemoryError } from './errors.js';
import * as s from './schemas.js';

type SessionRole = 'USER' | 'ASSISTANT';
type ObserverResult = void | PromiseLike<void>;
type SessionEventInput = z.infer<typeof s.event>;

interface SessionEventHookInputs {
  USER: { readonly messages: ReadonlyArray<ModelMessage> };
  ASSISTANT: { readonly finalStep: { readonly text: string } };
}

/** USER hooks consume onStart messages; ASSISTANT hooks consume onEnd final text. */
export type SessionEventHookInput<Role extends SessionRole = SessionRole> = SessionEventHookInputs[Role];

export type SessionEventHook<Role extends SessionRole = SessionRole> = (event: SessionEventHookInput<Role>) => Promise<void>;

/** Identity of an event about to be written or confirmed saved. Contains no message text. */
export interface SessionHookEvent {
  readonly sessionId: string;
  readonly role: SessionRole;
  readonly actorId: string;
}

export interface SessionEventHookErrorContext extends SessionHookEvent {
  readonly userId: string;
  /** A failed write may have committed; verify before retrying. */
  readonly phase: 'validation' | 'write';
}

export interface SessionEventHookOptions<Role extends SessionRole = SessionRole> {
  /** Record one USER event in onStart or one ASSISTANT event in onEnd. */
  role: Role;
  /** Event author. For USER events, this must match the scoped userId. */
  actorId: string;
  /** Required because the AI SDK ignores exceptions thrown by lifecycle callbacks. */
  onError: (error: RedisAgentMemoryToolError, context: SessionEventHookErrorContext) => ObserverResult;
  /** Optional observers are awaited; observer errors never change which events are written. */
  onEventStart?: (event: SessionHookEvent) => ObserverResult;
  onEventSaved?: (event: SessionHookEvent) => ObserverResult;
}

function invalidInput(message: string): never {
  throw new RedisAgentMemoryToolError('INVALID_SESSION_EVENT_INPUT', message);
}

function extractEvent(
  event: SessionEventHookInput,
  role: SessionRole,
  actorId: string,
): SessionEventInput | undefined {
  if (role === 'USER') {
    if (!('messages' in event) || !Array.isArray(event.messages)) {
      invalidInput('USER session recording requires messages from an onStart event.');
    }
    const messages: ReadonlyArray<ModelMessage> = event.messages;
    const user = messages.at(-1);
    if (user?.role !== 'user') invalidInput('Session recording requires the current final input message to have role user.');
    const content = typeof user.content === 'string'
      ? [{ text: user.content }]
      : user.content.flatMap(part => part.type === 'text' && part.text.length > 0 ? [{ text: part.text }] : []);
    return s.event.parse({ actorId, role, content });
  }
  if (!('finalStep' in event) || typeof event.finalStep?.text !== 'string') {
    invalidInput('ASSISTANT session recording requires finalStep.text from an onEnd event.');
  }
  if (event.finalStep.text.length === 0) return undefined;
  return s.event.parse({ actorId, role, content: [{ text: event.finalStep.text }] });
}

async function observe(callback: () => ObserverResult): Promise<void> {
  try { await callback(); } catch { /* Observers must not interrupt recording or cause a write to be retried. */ }
}

/** Internal adapter. The writer retains the toolset's immutable scope and shared SDK client. */
export function createSessionEventHook<Role extends SessionRole>(
  scope: { readonly userId?: string; readonly sessionId?: string },
  write: (event: SessionEventInput) => Promise<unknown>,
  options: SessionEventHookOptions<Role>,
): SessionEventHook<Role> {
  if (!scope.userId || !scope.sessionId) {
    throw new RedisAgentMemoryToolError('INVALID_SCOPE', 'createSessionEventHook requires scope.userId and scope.sessionId.');
  }
  if (typeof options?.onError !== 'function') throw new Error('createSessionEventHook requires an onError callback.');
  const { role, onError, onEventStart, onEventSaved } = options;
  if (role !== 'USER' && role !== 'ASSISTANT') throw new Error('createSessionEventHook requires role USER or ASSISTANT.');
  const actorId = s.id.parse(options.actorId);
  if (role === 'USER' && actorId !== scope.userId) {
    throw new RedisAgentMemoryToolError('INVALID_SCOPE', 'USER session event actorId must match scope.userId.');
  }
  for (const [name, observer] of [['onEventStart', onEventStart], ['onEventSaved', onEventSaved]] as const) {
    if (observer !== undefined && typeof observer !== 'function') throw new Error(`${name} must be a function.`);
  }
  const userId = scope.userId;
  const info: SessionHookEvent = Object.freeze({ sessionId: scope.sessionId, role, actorId });

  return async event => {
    let input: SessionEventInput | undefined;
    try {
      input = extractEvent(event, role, actorId);
    } catch (error) {
      const safeError = error instanceof RedisAgentMemoryToolError ? error
        : new RedisAgentMemoryToolError('INVALID_SESSION_EVENT_INPUT', `Session recording requires valid ${role} text. Each text part must be non-empty and at most 50,000 characters.`);
      await observe(() => onError(safeError, Object.freeze({ ...info, userId, phase: 'validation' })));
      return;
    }
    if (!input) return;

    await observe(() => onEventStart?.(info));
    try {
      await write(input);
    } catch (error) {
      await observe(() => onError(sanitizeMemoryError(error), Object.freeze({ ...info, userId, phase: 'write' })));
      return;
    }
    await observe(() => onEventSaved?.(info));
  };
}
