import { AgentMemory } from '@redis-iris/agent-memory';
import { HTTPClient } from '@redis-iris/agent-memory/lib/http.js';
import type { LongTermMemoryFilter } from '@redis-iris/agent-memory/models';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import * as s from './schemas.js';
import { createNamespaceTools } from './namespaces.js';
import { IrisToolError } from './errors.js';
export { irisMemoryInstructions } from './instructions.js';
export { IrisToolError } from './errors.js';

export interface IrisMemoryScope {
  /** Stable user identity. Applied to all long-term operations and session ownership checks. */
  ownerId?: string;
  /** Locks session operations and associates new memories; recall still spans this owner's sessions. */
  sessionId?: string;
  /** Deprecated label; prefer namespaceId for resource-backed namespaces. */
  namespace?: string;
  namespaceId?: string;
}
export interface RedisAgentMemoryOptions {
  storeId?: string;
  serverURL?: string;
  scope?: IrisMemoryScope;
  /** Defaults to true. False removes destructive tools from the model's tool list. */
  allowDeletes?: boolean;
  /** Expose namespace administration tools. Defaults to false. */
  namespaceTools?: boolean;
  timeoutMs?: number;
  /** Optional transport override for tests, tracing, or a proxy. No client instance is required. */
  fetch?: typeof globalThis.fetch;
}

function fail(message: string): never { throw new IrisToolError('INVALID_SCOPE', message); }
function status(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode : undefined;
}

/** Build ordinary AI SDK tools backed by the official Redis SDK. All credentials stay in closures. */
export function createIrisMemoryTools(apiKey?: string, options: RedisAgentMemoryOptions = {}): ToolSet {
  const env = typeof process === 'undefined' ? {} : process.env;
  const key = apiKey ?? env.AGENT_MEMORY_API_KEY;
  const storeId = options.storeId ?? env.AGENT_MEMORY_STORE_ID;
  if (!key?.trim()) throw new Error('Set AGENT_MEMORY_API_KEY or pass an Iris API key.');
  if (!storeId?.trim()) throw new Error('Set AGENT_MEMORY_STORE_ID or pass options.storeId.');
  const serverURL = options.serverURL ?? env.AGENT_MEMORY_URL ?? 'https://gcp-us-east4.memory.redis.io';
  const url = new URL(serverURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('serverURL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  const scope = Object.freeze({ ...options.scope });
  if (scope.ownerId !== undefined) s.ownerId.parse(scope.ownerId);
  if (scope.sessionId !== undefined) s.sessionId.parse(scope.sessionId);
  if (scope.namespaceId !== undefined) s.id.parse(scope.namespaceId);
  if (scope.namespace !== undefined && !scope.namespace.trim()) throw new Error('scope.namespace must not be empty.');
  if (scope.namespace !== undefined && scope.namespaceId !== undefined) throw new Error('Choose scope.namespace or scope.namespaceId.');
  if (options.namespaceTools && scope.namespace !== undefined) throw new Error('Namespace resource tools cannot use a legacy namespace scope.');
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('timeoutMs must be positive.');
  const client = new AgentMemory({ apiKey: key, storeId, serverURL, timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.fetch ? { httpClient: new HTTPClient({ fetcher: options.fetch }) } : {}),
  });
  const deletes = options.allowDeletes ?? true;
  type Placement = { namespace?: string; namespaceRef?: { namespaceId: string } };
  const checkPlacement = (value: Placement) => {
    if (value.namespace !== undefined && value.namespaceRef !== undefined) fail('Supply namespace or namespaceRef, never both.');
    if (scope.namespace !== undefined && value.namespace !== scope.namespace) fail('Resource is outside the configured namespace.');
    if (scope.namespaceId !== undefined && value.namespaceRef?.namespaceId !== scope.namespaceId) fail('Resource is outside the configured namespace resource.');
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
    if (scope.ownerId && value && value !== scope.ownerId) fail('Cannot override owner scope.');
    const resolved = value ?? scope.ownerId;
    if (!resolved) fail('Supply ownerId or configure scope.ownerId.');
    return resolved;
  };
  const assertSession = async (sessionId: string, signal?: AbortSignal) => {
    resolveSession(sessionId);
    const session = await client.getSessionMemory(sessionId, false, { signal });
    if (scope.ownerId && session.ownerId !== scope.ownerId) fail('Session is outside the configured owner scope.');
    checkPlacement(session);
    return session;
  };
  const assertMemory = async (id: string, signal?: AbortSignal) => {
    const memory = await client.getLongTermMemory(id, { signal });
    if (scope.ownerId && memory.ownerId !== scope.ownerId) fail('Memory is outside the configured owner scope.');
    checkPlacement(memory);
    return memory;
  };
  const hasResourceScope = Boolean(scope.ownerId || scope.namespace !== undefined || scope.namespaceId);
  const assertPlacementOwner = async (value: Placement, signal?: AbortSignal) => {
    if (!scope.ownerId || !value.namespaceRef) return;
    const { namespace } = await client.getNamespace(value.namespaceRef.namespaceId, { signal });
    const root = namespace.rootId === namespace.namespaceId ? namespace
      : (await client.getNamespace(namespace.rootId, { signal })).namespace;
    if (root.scope !== 'PERSONAL' || root.ownerId !== scope.ownerId) fail('Namespace placement is outside the configured owner’s personal namespaces.');
  };
  const append = async (input: z.infer<typeof s.event>, signal?: AbortSignal, start = false) => {
    const placed = place(input);
    const sessionId = input.sessionId ?? scope.sessionId;
    if (sessionId) {
      resolveSession(sessionId);
      if (hasResourceScope || start) {
        try {
          await assertSession(sessionId, signal);
          if (start) fail('This session already exists; use add_session_event.');
        } catch (error) {
          if (status(error) !== 404) throw error;
          if (scope.ownerId && (input.actorId !== scope.ownerId || input.role !== 'USER')) fail('A new session must start with a USER event whose actorId is the configured ownerId.');
        }
      }
    } else if (scope.ownerId && (input.actorId !== scope.ownerId || input.role !== 'USER')) {
      fail('A new session must start with a USER event whose actorId is the configured ownerId.');
    }
    await assertPlacementOwner(placed, signal);
    return client.addSessionEvent({ ...placed, sessionId, createdAt: input.createdAt ? new Date(input.createdAt) : new Date() }, { signal });
  };
  const sessionInput = z.object({ sessionId: s.sessionId.optional() });
  const eventInput = sessionInput.extend({ eventId: s.id });
  const tools: ToolSet = {
    get_memory_context: tool({
      description: 'Get fixed memory scope and identity rules before using memory. Contains no credentials.',
      inputSchema: z.object({}), execute: async () => ({ ...scope, allowDeletes: deletes,
        sessionOwnerRule: 'The first event actor becomes the immutable session owner. Start with the user.',
        longTermRecall: 'Search spans sessions unless an explicit session filter is supplied.',
      }),
    }),
    start_session: tool({
      description: 'Start a conversation with the user’s first event. Iris generates and returns a session ID when none is provided. Retain the returned ID.',
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
        if (scope.ownerId && result.ownerId !== scope.ownerId) fail('Session is outside the configured owner scope.');
        checkPlacement(result); return result;
      },
    }),
    list_sessions: tool({
      description: 'List session IDs for an owner, with pagination. Unscoped callers must explicitly request includeAll to list the whole store.',
      inputSchema: z.object({ ownerId: s.ownerId.optional(), includeAll: z.boolean().optional(), ...s.page,
        limit: z.number().int().min(1).max(1000).optional() }),
      execute: async (input, { abortSignal }) => {
        if (scope.sessionId) {
          if (input.ownerId && scope.ownerId && input.ownerId !== scope.ownerId) fail('Cannot override owner scope.');
          await assertSession(scope.sessionId, abortSignal);
          return { items: [scope.sessionId], total: 1 };
        }
        if (scope.namespace !== undefined || scope.namespaceId) fail('The Iris session-list API cannot filter namespaces. Use a known session ID with get_session_memory.');
        if (input.includeAll && (scope.ownerId || input.ownerId)) fail('includeAll cannot be combined with an owner scope or ownerId.');
        const owner = input.ownerId || scope.ownerId;
        if (!owner && !input.includeAll) fail('Supply ownerId or explicitly set includeAll: true.');
        if (owner) resolveOwner(owner);
        return client.listSessions(input.limit, input.pageToken, owner, owner ? undefined : true, { signal: abortSignal });
      },
    }),
    create_memories: tool({
      description: 'Create 1–100 durable memories. Use stable unique IDs and the user’s ownerId. Inspect created and per-record errors before retrying.',
      inputSchema: z.object({ memories: z.array(s.memory).min(1).max(100) }),
      execute: async ({ memories }, { abortSignal }) => {
        const records = memories.map(memory => {
          const sessionId = memory.sessionId ?? scope.sessionId;
          if (scope.sessionId && sessionId !== scope.sessionId) fail('Cannot override session association.');
          return { ...place(memory), ownerId: resolveOwner(memory.ownerId), sessionId };
        });
        const checkedNamespaces = new Set<string>();
        for (const record of records) {
          const namespaceId = record.namespaceRef?.namespaceId;
          if (namespaceId && !checkedNamespaces.has(namespaceId)) {
            await assertPlacementOwner(record, abortSignal);
            checkedNamespaces.add(namespaceId);
          }
        }
        return client.bulkCreateLongTermMemories({ memories: records }, { signal: abortSignal });
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
        if (filter.namespace && filter.namespaceRef) fail('Supply namespace or namespaceRef, never both.');
        if (filter.unnamespaced !== undefined && (filter.namespace || filter.namespaceRef)) fail('unnamespaced cannot be combined with namespace selectors.');
        if (hasResourceScope && input.filterOp === 'any') fail('Scoped searches require filterOp all to preserve isolation.');
        const fixed = (name: 'ownerId' | 'namespace' | 'namespaceRef', value: string) => {
          const existing = filter[name];
          if (existing && (existing.eq !== value || Object.values(existing).filter(v => v !== undefined).length !== 1)) fail(`Cannot override ${name} scope.`);
          filter[name] = { eq: value };
        };
        if (scope.ownerId) fixed('ownerId', scope.ownerId);
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
        return client.searchLongTermMemory({ ...input, filter, filterOp: hasResourceScope ? 'all' : input.filterOp }, { signal: abortSignal });
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
    ownerId: scope.ownerId, namespaceId: scope.namespaceId, allowDeletes: deletes, assertMemory,
  }));
  // Errors from the generated SDK may contain response bodies and headers. Never expose these to the model.
  for (const entry of Object.values(tools)) {
    const execute = entry.execute!;
    entry.execute = async (input, execution) => {
      try { return await execute(input, execution); }
      catch (error) {
        if (execution.abortSignal?.aborted) throw new DOMException('Memory operation aborted.', 'AbortError');
        if (error instanceof IrisToolError) throw error;
        const code = status(error);
        throw new IrisToolError(code ? `IRIS_HTTP_${code}` : 'IRIS_REQUEST_FAILED',
          code ? `Iris request failed (HTTP ${code}). Check service configuration and request scope. Writes may have partially succeeded; verify before retrying.`
            : 'Iris request failed. Check connectivity and service configuration. Verify writes before retrying.', code);
      }
    };
  }
  return tools;
}

/** Pass directly as `tools: new RedisAgentMemory(apiKey, options)`. Only tools are enumerable. */
export class RedisAgentMemory {
  [name: string]: ToolSet[string];
  constructor(apiKey?: string, options: RedisAgentMemoryOptions = {}) {
    Object.assign(this, createIrisMemoryTools(apiKey, options));
  }
}
