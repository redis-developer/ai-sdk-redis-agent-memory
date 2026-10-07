import { AgentMemory } from '@redis-iris/agent-memory';
import type { LongTermMemoryFilter } from '@redis-iris/agent-memory/models';
import type { z } from 'zod';
import { RedisAgentMemoryToolError } from './errors.js';
import * as s from './schemas.js';

export interface RedisAgentMemoryScope {
  /** Stable application user ID. Used as the memory owner and as the actor for USER events. */
  userId?: string;
  /** Locks session operations and associates new memories; recall still spans this user's sessions. */
  sessionId?: string;
  /** Deprecated label; prefer namespaceId for resource-backed namespaces. */
  namespace?: string;
  namespaceId?: string;
}

export interface ScopeValidationOptions {
  namespaceTools?: boolean;
}

export type ScopedMemoryRequestOptions = NonNullable<Parameters<AgentMemory['getSessionMemory']>[2]>;
type SessionEventInput = z.infer<typeof s.event>;
type SearchInput = NonNullable<Parameters<AgentMemory['searchLongTermMemory']>[0]>;
type Placement = { namespace?: string; namespaceRef?: { namespaceId: string } };

export interface AppendSessionEventOptions extends ScopedMemoryRequestOptions {
  /** Reject when the named session already exists. Used by the legacy start_session tool. */
  start?: boolean;
  /** Re-read a session created by this append to verify its immutable owner and placement. */
  postflightNewSession?: boolean;
  /** @internal Reports whether the append POST started or was acknowledged. */
  onPostStatus?: (status: 'started' | 'acknowledged') => void;
  /** @internal Validates the echoed event identity for wrapper writes. */
  validateResponse?: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Memory operation aborted.', 'AbortError');
}

function fail(message: string): never {
  throw new RedisAgentMemoryToolError('INVALID_SCOPE', message);
}

export function memoryErrorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode : undefined;
}

/** Resolve and validate connection configuration without exposing credentials outside the SDK client. */
export function resolveAgentMemoryClient(
  serverUrl?: string,
  storeId?: string,
  apiKey?: string,
  timeoutMs = 30_000,
  env: Readonly<Record<string, string | undefined>> = typeof process === 'undefined' ? {} : process.env,
): AgentMemory {
  const key = apiKey ?? env.AGENT_MEMORY_API_KEY;
  const resolvedStoreId = storeId ?? env.AGENT_MEMORY_STORE_ID;
  if (!key?.trim()) throw new Error('Set AGENT_MEMORY_API_KEY or pass an Iris API key.');
  if (!resolvedStoreId?.trim()) throw new Error('Set AGENT_MEMORY_STORE_ID or pass storeId.');
  const serverURL = serverUrl ?? env.AGENT_MEMORY_URL ?? 'https://gcp-us-east4.memory.redis.io';
  const url = new URL(serverURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('serverUrl must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive.');
  return new AgentMemory({ apiKey: key, storeId: resolvedStoreId, serverURL, timeoutMs });
}

export function copyMemoryScope(
  scope: RedisAgentMemoryScope,
  options: ScopeValidationOptions = {},
): Readonly<RedisAgentMemoryScope> {
  const copied = Object.freeze({ ...scope });
  if (copied.userId !== undefined) s.ownerId.parse(copied.userId);
  if (copied.sessionId !== undefined) s.sessionId.parse(copied.sessionId);
  if (copied.namespaceId !== undefined) s.id.parse(copied.namespaceId);
  if (copied.namespace !== undefined && !copied.namespace.trim()) throw new Error('scope.namespace must not be empty.');
  if (copied.namespace !== undefined && copied.namespaceId !== undefined) throw new Error('Choose scope.namespace or scope.namespaceId.');
  if (options.namespaceTools && copied.namespace !== undefined) throw new Error('Namespace resource tools cannot use a legacy namespace scope.');
  return copied;
}

export function extendMemoryScope(
  scope: RedisAgentMemoryScope,
  context: RedisAgentMemoryScope,
): RedisAgentMemoryScope {
  const extended = { ...scope };
  for (const name of ['userId', 'sessionId', 'namespace', 'namespaceId'] as const) {
    const value = context[name];
    if (value === undefined) continue;
    if (scope[name] !== undefined && scope[name] !== value) fail(`Cannot override ${name} scope.`);
    extended[name] = value;
  }
  return extended;
}

/**
 * Security boundary shared by tools, hooks, and the provider wrapper.
 * The client and validated scope are captured once and never exposed as enumerable state.
 */
export function createScopedMemory(client: AgentMemory, inputScope: RedisAgentMemoryScope) {
  const scope = copyMemoryScope(inputScope);
  const hasResourceScope = Boolean(scope.userId || scope.namespace !== undefined || scope.namespaceId);

  const checkPlacement = (value: Placement) => {
    if (value.namespace !== undefined && value.namespaceRef !== undefined) fail('Supply namespace or namespaceRef, never both.');
    if (scope.namespace !== undefined && value.namespace !== scope.namespace) fail('Resource is outside the configured namespace.');
    if (scope.namespaceId !== undefined && value.namespaceRef?.namespaceId !== scope.namespaceId) {
      fail('Resource is outside the configured namespace resource.');
    }
  };

  const place = <T extends Placement>(input: T): T => {
    const value = { ...input };
    if (value.namespace !== undefined && value.namespaceRef !== undefined) fail('Supply namespace or namespaceRef, never both.');
    if (scope.namespace !== undefined) {
      if (value.namespaceRef || (value.namespace !== undefined && value.namespace !== scope.namespace)) fail('Cannot override namespace scope.');
      value.namespace = scope.namespace;
    }
    if (scope.namespaceId !== undefined) {
      if (value.namespace !== undefined || (value.namespaceRef && value.namespaceRef.namespaceId !== scope.namespaceId)) fail('Cannot override namespace scope.');
      value.namespaceRef = { namespaceId: scope.namespaceId };
    }
    return value;
  };

  const resolveSession = (value?: string) => {
    if (scope.sessionId && value && value !== scope.sessionId) fail('Cannot override session scope.');
    const resolved = value ?? scope.sessionId;
    if (!resolved) fail('Supply sessionId or configure scope.sessionId.');
    return resolved;
  };

  const resolveOwner = (value?: string) => {
    if (scope.userId && value && value !== scope.userId) fail('Cannot override user scope.');
    const resolved = value ?? scope.userId;
    if (!resolved) fail('Supply ownerId or configure scope.userId.');
    return resolved;
  };

  const assertSession = async (
    sessionId: string,
    options?: ScopedMemoryRequestOptions,
    validateSessionId = false,
  ) => {
    resolveSession(sessionId);
    const session = await client.getSessionMemory(sessionId, false, options);
    if (validateSessionId && session.sessionId !== sessionId) fail('Session response does not match the configured session scope.');
    if (scope.userId && session.ownerId !== scope.userId) fail('Session is outside the configured user scope.');
    checkPlacement(session);
    return session;
  };

  const restoreSession = (options?: ScopedMemoryRequestOptions) => assertSession(resolveSession(), options);
  const restoreScopedSession = (options?: ScopedMemoryRequestOptions) => assertSession(resolveSession(), options, true);

  const assertMemory = async (id: string, options?: ScopedMemoryRequestOptions) => {
    const memory = await client.getLongTermMemory(id, options);
    if (scope.userId && memory.ownerId !== scope.userId) fail('Memory is outside the configured user scope.');
    checkPlacement(memory);
    return memory;
  };

  const assertPlacementOwner = async (value: Placement, options?: ScopedMemoryRequestOptions) => {
    if (!scope.userId || !value.namespaceRef) return;
    const signal = options?.signal ?? undefined;
    throwIfAborted(signal);
    const { namespace } = await client.getNamespace(value.namespaceRef.namespaceId, options);
    throwIfAborted(signal);
    const root = namespace.rootId === namespace.namespaceId ? namespace
      : (await client.getNamespace(namespace.rootId, options)).namespace;
    throwIfAborted(signal);
    if (root.scope !== 'PERSONAL' || root.ownerId !== scope.userId) {
      fail('Namespace placement is outside the configured user’s personal namespaces.');
    }
  };

  const scopeSearch = (input: SearchInput): SearchInput => {
    const filter: LongTermMemoryFilter = { ...input.filter };
    if (filter.namespace && filter.namespaceRef) fail('Supply namespace or namespaceRef, never both.');
    if (filter.unnamespaced !== undefined && (filter.namespace || filter.namespaceRef)) {
      fail('unnamespaced cannot be combined with namespace selectors.');
    }
    if (hasResourceScope && input.filterOp === 'any') fail('Scoped searches require filterOp all to preserve isolation.');
    const fixed = (name: 'ownerId' | 'namespace' | 'namespaceRef', value: string) => {
      const existing = filter[name];
      if (existing && (existing.eq !== value || Object.values(existing).filter(item => item !== undefined).length !== 1)) {
        fail(`Cannot override ${name} scope.`);
      }
      filter[name] = { eq: value };
    };
    if (scope.userId) fixed('ownerId', scope.userId);
    if (scope.namespace !== undefined || scope.namespaceId) {
      if (filter.unnamespaced !== undefined) fail('Cannot search unnamespaced records within a namespace scope.');
      if (scope.namespace !== undefined) {
        if (filter.namespaceRef) fail('Cannot override namespace scope.');
        fixed('namespace', scope.namespace);
      } else {
        if (filter.namespace) fail('Cannot override namespace scope.');
        fixed('namespaceRef', scope.namespaceId!);
      }
    }
    return { ...input, filter, filterOp: hasResourceScope ? 'all' : input.filterOp };
  };

  const searchLongTermMemory = (
    input: SearchInput,
    options?: ScopedMemoryRequestOptions,
  ) => client.searchLongTermMemory(scopeSearch(input), options);

  const searchPersonalMemories = async (
    text: string,
    limit: number,
    options?: ScopedMemoryRequestOptions,
  ) => {
    const result = await searchLongTermMemory({ text, limit }, options);
    for (const memory of result.items) {
      if (scope.userId && memory.ownerId !== scope.userId) fail('Memory is outside the configured user scope.');
      checkPlacement(memory);
    }
    return result;
  };

  const appendSessionEvent = async (
    input: SessionEventInput,
    options: AppendSessionEventOptions = {},
  ) => {
    const {
      start = false, postflightNewSession = false, onPostStatus, validateResponse = false, ...requestOptions
    } = options;
    const requestSignal = requestOptions.signal ?? undefined;
    const placed = place(input);
    const sessionId = input.sessionId ?? scope.sessionId;
    let newSession = false;
    if (sessionId) {
      resolveSession(sessionId);
      if (hasResourceScope || start) {
        throwIfAborted(requestSignal);
        try {
          await assertSession(sessionId, requestOptions, validateResponse);
          throwIfAborted(requestSignal);
          if (start) fail('This session already exists; use add_session_event.');
        } catch (error) {
          if (memoryErrorStatus(error) !== 404) throw error;
          newSession = true;
          if (scope.userId && (input.actorId !== scope.userId || input.role !== 'USER')) {
            fail('A new session must start with a USER event whose actorId is the configured userId.');
          }
        }
      }
    } else if (scope.userId && (input.actorId !== scope.userId || input.role !== 'USER')) {
      fail('A new session must start with a USER event whose actorId is the configured userId.');
    }
    throwIfAborted(requestSignal);
    await assertPlacementOwner(placed, requestOptions);
    throwIfAborted(requestSignal);
    onPostStatus?.('started');
    const result = await client.addSessionEvent({
      ...placed,
      sessionId,
      createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
    }, requestOptions);
    onPostStatus?.('acknowledged');
    if (validateResponse && (
      result.event.sessionId !== sessionId || result.event.actorId !== input.actorId || result.event.role !== input.role
    )) {
      fail('Saved event is outside the configured session or actor scope.');
    }
    throwIfAborted(requestSignal);
    if (postflightNewSession && newSession && sessionId) {
      await assertSession(sessionId, requestOptions, validateResponse);
      throwIfAborted(requestSignal);
    }
    return result;
  };

  return Object.freeze({
    scope,
    hasResourceScope,
    checkPlacement,
    place,
    resolveSession,
    resolveOwner,
    assertSession,
    restoreSession,
    restoreScopedSession,
    assertMemory,
    assertPlacementOwner,
    scopeSearch,
    searchLongTermMemory,
    searchPersonalMemories,
    appendSessionEvent,
  });
}

export type ScopedMemory = ReturnType<typeof createScopedMemory>;
