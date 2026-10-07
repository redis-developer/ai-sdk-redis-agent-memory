import type { AgentMemory } from '@redis-iris/agent-memory';
import type { LongTermMemoryFilter } from '@redis-iris/agent-memory/models';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import * as s from './schemas.js';
import { createNamespaceTools } from './namespaces.js';
import { RedisAgentMemoryToolError, sanitizeMemoryError } from './errors.js';
import { createSessionEventHook, type SessionEventHook, type SessionEventHookOptions } from './session-event-hook.js';
import {
  copyMemoryScope,
  createScopedMemory,
  extendMemoryScope,
  resolveAgentMemoryClient,
  type RedisAgentMemoryScope,
} from './scoped-memory.js';
export { instructions } from './instructions.js';
export { RedisAgentMemoryToolError } from './errors.js';
export type {
  SessionEventHook, SessionEventHookInput, SessionEventHookOptions,
  SessionHookEvent, SessionEventHookErrorContext,
} from './session-event-hook.js';
export type { RedisAgentMemoryScope } from './scoped-memory.js';
export interface RedisAgentMemoryOptions {
  /** Expose deletion tools. Defaults to false. */
  allowDeletes?: boolean;
  /** Expose namespace administration tools. Defaults to false. */
  namespaceTools?: boolean;
  /** HTTP request timeout in milliseconds. Defaults to 30,000. Must be positive and finite. */
  timeoutMs?: number;
}

/** A tool map with non-enumerable helpers for scoping and application session recording. */
export type RedisAgentMemoryTools = ToolSet & {
  readonly withContext: (scope: RedisAgentMemoryScope) => RedisAgentMemoryTools;
  /** Record USER text in onStart or ASSISTANT text in onEnd. Requires fixed userId/sessionId. */
  readonly createSessionEventHook: <Role extends SessionEventHookOptions['role']>(options: SessionEventHookOptions<Role>) => SessionEventHook<Role>;
};

function fail(message: string): never { throw new RedisAgentMemoryToolError('INVALID_SCOPE', message); }

/**
 * Build ordinary AI SDK tools backed by the official Redis SDK. All credentials stay in closures.
 * @param serverUrl Defaults to AGENT_MEMORY_URL, then the production US East endpoint.
 * @param storeId Required here or through AGENT_MEMORY_STORE_ID.
 * @param apiKey Required here or through AGENT_MEMORY_API_KEY.
 * @param scope Fixed user, session, and namespace boundaries, copied at construction.
 * @param options Deletion and namespace administration tools are disabled by default.
 */
export function createRedisAgentMemoryTools(
  serverUrl?: string,
  storeId?: string,
  apiKey?: string,
  scope: RedisAgentMemoryScope = {},
  options: RedisAgentMemoryOptions = {},
): RedisAgentMemoryTools {
  options = Object.freeze({ ...options });
  scope = copyMemoryScope(scope, options);
  const client = resolveAgentMemoryClient(serverUrl, storeId, apiKey, options.timeoutMs ?? 30_000);
  return buildTools(client, scope, options);
}

function buildTools(
  client: AgentMemory,
  scope: Readonly<RedisAgentMemoryScope>,
  options: Readonly<RedisAgentMemoryOptions>,
): RedisAgentMemoryTools {
  const deletes = options.allowDeletes ?? false;
  const scoped = createScopedMemory(client, scope);
  const {
    place, resolveSession, resolveOwner, checkPlacement, hasResourceScope,
  } = scoped;
  const assertSession = (sessionId: string, signal?: AbortSignal) => scoped.assertSession(sessionId, { signal });
  const assertMemory = (id: string, signal?: AbortSignal) => scoped.assertMemory(id, { signal });
  const assertPlacementOwner = (
    value: { namespace?: string; namespaceRef?: { namespaceId: string } },
    signal?: AbortSignal,
  ) => scoped.assertPlacementOwner(value, { signal });
  const append = (input: z.infer<typeof s.event>, signal?: AbortSignal, start = false) => (
    scoped.appendSessionEvent(input, { signal, start })
  );
  const sessionInput = z.object({ sessionId: s.sessionId.optional() });
  const eventInput = sessionInput.extend({ eventId: s.id });
  const tools: ToolSet = {
    get_memory_context: tool({
      description: 'Get fixed memory scope and identity rules before using memory. Contains no credentials.',
      inputSchema: z.object({}), execute: async () => ({ ...scope, allowDeletes: deletes,
        userIdentityRule: 'Use userId as ownerId for the user’s memories and actorId for USER events. ASSISTANT events use the agent’s actorId.',
        sessionOwnerRule: 'The first event actor becomes the immutable session owner. Start with the user.',
        longTermRecall: 'Search spans sessions unless an explicit session filter is supplied.',
      }),
    }),
    start_session: tool({
      description: 'Start a conversation with the user’s first event. Redis Agent Memory generates and returns a session ID when none is provided. Retain the returned ID.',
      inputSchema: z.object({ sessionId: s.sessionId.optional(), actorId: s.id, text: s.text, ...s.placement }),
      execute: (input, { abortSignal }) => append({ ...input, role: 'USER', content: [{ text: input.text }] }, abortSignal, true),
    }),
    add_session_event: tool({
      description: 'Append a USER, ASSISTANT, or SYSTEM event. Reuse the conversation’s sessionId. actorId is the author. Do not duplicate application logging or blindly retry an uncertain append.',
      inputSchema: s.event, execute: (input, { abortSignal }) => append(input, abortSignal),
    }),
    get_session_event: tool({
      description: 'Get one event by sessionId and eventId.', inputSchema: eventInput,
      execute: async (input, { abortSignal }) => {
        const sessionId = resolveSession(input.sessionId);
        if (hasResourceScope) await assertSession(sessionId, abortSignal);
        return client.getSessionEvent(sessionId, input.eventId, { signal: abortSignal });
      },
    }),
    get_session_memory: tool({
      description: 'Get conversation events and its latest summary. Include summarized events only when full older history is needed.',
      inputSchema: sessionInput.extend({ includeSummarisedEvents: z.boolean().optional() }),
      execute: async (input, { abortSignal }) => {
        const result = await client.getSessionMemory(resolveSession(input.sessionId), input.includeSummarisedEvents, { signal: abortSignal });
        if (scope.userId && result.ownerId !== scope.userId) fail('Session is outside the configured user scope.');
        checkPlacement(result); return result;
      },
    }),
    list_sessions: tool({
      description: 'List session IDs for an owner, with pagination. Unscoped callers must explicitly request includeAll to list the whole store.',
      inputSchema: z.object({ ownerId: s.ownerId.optional(), includeAll: z.boolean().optional(), ...s.page,
        limit: z.number().int().min(1).max(1000).optional() }),
      execute: async (input, { abortSignal }) => {
        if (scope.sessionId) {
          if (input.ownerId && scope.userId && input.ownerId !== scope.userId) fail('Cannot override user scope.');
          await assertSession(scope.sessionId, abortSignal);
          return { items: [scope.sessionId], total: 1 };
        }
        if (scope.namespace !== undefined || scope.namespaceId) fail('The Iris session-list API cannot filter namespaces. Use a known session ID with get_session_memory.');
        if (input.includeAll && (scope.userId || input.ownerId)) fail('includeAll cannot be combined with a user scope or ownerId.');
        const owner = input.ownerId || scope.userId;
        if (!owner && !input.includeAll) fail('Supply ownerId or explicitly set includeAll: true.');
        if (owner) resolveOwner(owner);
        return client.listSessions(input.limit, input.pageToken, owner, owner ? undefined : true, { signal: abortSignal });
      },
    }),
    create_memories: tool({
      description: 'Create up to 100 durable memories in one batch. UUIDs are generated automatically; do not supply IDs. Use the user ID as ownerId; fixed scope.userId supplies it automatically. Returned memoryIds match input order; created and errors report outcomes. New calls generate new IDs, so reconcile uncertain writes before retrying.',
      inputSchema: z.object({ memories: z.array(s.memory).min(1).max(100) }),
      execute: async ({ memories }, { abortSignal }) => {
        const records = memories.map(memory => {
          const sessionId = memory.sessionId ?? scope.sessionId;
          if (scope.sessionId && sessionId !== scope.sessionId) fail('Cannot override session association.');
          return { ...place(memory), id: globalThis.crypto.randomUUID(), ownerId: resolveOwner(memory.ownerId), sessionId };
        });
        const checkedNamespaces = new Set<string>();
        for (const record of records) {
          const namespaceId = record.namespaceRef?.namespaceId;
          if (namespaceId && !checkedNamespaces.has(namespaceId)) {
            await assertPlacementOwner(record, abortSignal);
            checkedNamespaces.add(namespaceId);
          }
        }
        const result = await client.bulkCreateLongTermMemories({ memories: records }, { signal: abortSignal });
        return { ...result, memoryIds: records.map(record => record.id) };
      },
    }),
    get_memory: tool({
      description: 'Get a long-term memory by ID within the configured scope.', inputSchema: z.object({ memoryId: s.id }),
      execute: ({ memoryId }, { abortSignal }) => assertMemory(memoryId, abortSignal),
    }),
    search_memories: tool({
      description: 'Search durable memories semantically or list with filters. Results are items plus optional nextPageToken. Recall spans conversations. Scoped searches require filterOp all.',
      inputSchema: s.search,
      execute: async (input, { abortSignal }) => {
        const filter: LongTermMemoryFilter = { ...input.filter, createdAt: input.filter?.createdAt
          ? Object.fromEntries(Object.entries(input.filter.createdAt).filter(([,v]) => v !== undefined).map(([k,v]) => [k, new Date(v!)])) : undefined };
        return scoped.searchLongTermMemory({ ...input, filter }, { signal: abortSignal });
      },
    }),
    update_memory: tool({
      description: 'Correct a memory’s text or organization. Supply at least one change. Custom attributes are supplied at creation; custom extraction-worker updates are outside this toolset.',
      inputSchema: z.object({ memoryId: s.id, changes: s.memoryUpdate }),
      execute: async ({ memoryId, changes }, { abortSignal }) => {
        if (!Object.values(changes).some(v => v !== undefined)) fail('Supply at least one change.');
        if (hasResourceScope) await assertMemory(memoryId, abortSignal);
        if (changes.ownerId !== undefined) resolveOwner(changes.ownerId);
        if (scope.sessionId && changes.sessionId !== undefined && changes.sessionId !== scope.sessionId) fail('Cannot override session association.');
        const placed = place(changes);
        await assertPlacementOwner(placed, abortSignal);
        return client.updateLongTermMemory(memoryId, placed, { signal: abortSignal });
      },
    }),
  };
  if (deletes) Object.assign(tools, {
    delete_memories: tool({
      description: 'Delete 1–100 long-term memories by ID. Use for explicit forget requests. Inspect deleted and per-record errors.',
      inputSchema: z.object({ memoryIds: z.array(s.id).min(1).max(100) }),
      execute: async ({ memoryIds }, { abortSignal }) => {
        if (hasResourceScope) for (const id of memoryIds) await assertMemory(id, abortSignal);
        return client.bulkDeleteLongTermMemories({ memoryIds }, { signal: abortSignal });
      },
    }),
    delete_session_event: tool({
      description: 'Delete one event. Previously promoted long-term memories remain and must be deleted separately.', inputSchema: eventInput,
      execute: async (input, { abortSignal }) => {
        const sessionId = resolveSession(input.sessionId);
        if (hasResourceScope) await assertSession(sessionId, abortSignal);
        await client.deleteSessionEvent(sessionId, input.eventId, { signal: abortSignal });
        return { deleted: true, sessionId, eventId: input.eventId };
      },
    }),
    delete_session_memory: tool({
      description: 'Delete a conversation’s session memory. This does not delete promoted long-term memories.', inputSchema: sessionInput,
      execute: async (input, { abortSignal }) => {
        const sessionId = resolveSession(input.sessionId);
        if (hasResourceScope) await assertSession(sessionId, abortSignal);
        await client.deleteSessionMemory(sessionId, { signal: abortSignal });
        return { deleted: true, sessionId };
      },
    }),
  });
  if (options.namespaceTools) Object.assign(tools, createNamespaceTools(client, {
    ownerId: scope.userId, namespaceId: scope.namespaceId, allowDeletes: deletes, assertMemory,
  }));
  // Errors from the generated SDK may contain response bodies and headers. Never expose these to the model.
  for (const entry of Object.values(tools)) {
    const execute = entry.execute!;
    entry.execute = async (input, execution) => {
      try { return await execute(input, execution); }
      catch (error) {
        if (execution.abortSignal?.aborted) throw new DOMException('Memory operation aborted.', 'AbortError');
        throw sanitizeMemoryError(error);
      }
    };
  }
  // Keep application helpers out of AI SDK tool enumeration and object spreads.
  Object.defineProperties(tools, {
    withContext: {
      value: (context: RedisAgentMemoryScope) => buildTools(
        client,
        copyMemoryScope(extendMemoryScope(scope, context), options),
        options,
      ),
    },
    createSessionEventHook: {
      value: (hookOptions: SessionEventHookOptions) => createSessionEventHook(scope, append, hookOptions),
    },
  });
  return tools as RedisAgentMemoryTools;
}

const RedisAgentMemoryConstructor = class RedisAgentMemory {
  constructor(
    serverUrl?: string,
    storeId?: string,
    apiKey?: string,
    scope: RedisAgentMemoryScope = {},
    options: RedisAgentMemoryOptions = {},
  ) {
    Object.defineProperties(this, Object.getOwnPropertyDescriptors(
      createRedisAgentMemoryTools(serverUrl, storeId, apiKey, scope, options),
    ));
  }
};

export type RedisAgentMemory = RedisAgentMemoryTools;

// Expose the tool-map intersection at the constructor boundary so withContext remains a method, not a tool.
/** Pass directly as `tools: new RedisAgentMemory(serverUrl, storeId, apiKey, scope, options)`. Only tools are enumerable. */
export const RedisAgentMemory = RedisAgentMemoryConstructor as unknown as {
  new (...args: ConstructorParameters<typeof RedisAgentMemoryConstructor>): RedisAgentMemory;
  readonly prototype: RedisAgentMemory;
};
