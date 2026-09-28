import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent, isStepCount, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  RedisAgentMemory, createRedisAgentMemoryTools, instructions,
  type RedisAgentMemoryOptions, type RedisAgentMemoryScope,
} from '../src/index.js';

const apiKey = 'test-secret-iris-key';
const serverURL = 'https://iris.example.test';
const timestamp = '2026-09-25T12:34:56.000Z';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function memory(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memory-1', text: 'Prefers concise replies.', ownerId: 'user-1',
    sessionId: 'older-session', createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'event-1', sessionId: 'session-1', actorId: 'user-1', role: 'USER',
    content: [{ text: 'Hello.' }], createdAt: timestamp, systemTimestamp: timestamp, ...overrides,
  };
}

function namespace(overrides: Record<string, unknown> = {}) {
  return {
    namespaceId: 'root-1', name: 'personal', rootId: 'root-1', ownerId: 'user-1',
    scope: 'PERSONAL', state: 'ACTIVE', revision: 1, path: '/personal',
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

/** Exercise the official SDK against a fake HTTP boundary, rather than mocking its methods. */
function transport(...responses: Array<{ body: unknown; status?: number }>) {
  const requests: Array<{ request: Request; body: any }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ request, body });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
    return new Response(JSON.stringify(typeof response.body === 'function' ? response.body(body) : response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

async function run(tools: ToolSet, name: string, input: unknown, abortSignal?: AbortSignal): Promise<any> {
  const definition = tools[name];
  if (!definition?.execute) throw new Error(`No executable tool named ${name}`);
  const schema = definition.inputSchema as { parseAsync(input: unknown): Promise<unknown> };
  const parsed = await schema.parseAsync(input);
  return definition.execute(parsed, { toolCallId: 'test-call', messages: [], abortSignal, context: {} });
}

function toolsWith(
  fetch: typeof globalThis.fetch,
  scope: RedisAgentMemoryScope = {},
  options: RedisAgentMemoryOptions = {},
) {
  vi.stubGlobal('fetch', fetch);
  return new RedisAgentMemory(serverURL, 'store-1', apiKey, scope, options);
}

describe('RedisAgentMemory toolset', () => {
  it('can be passed directly as a ToolSet and exposes no enumerable client or credentials', () => {
    const tools: ToolSet = toolsWith(transport().fetch);
    expect(Object.keys(tools)).toEqual([
      'get_memory_context', 'start_session', 'add_session_event', 'get_session_event',
      'get_session_memory', 'list_sessions', 'create_memories', 'get_memory',
      'search_memories', 'update_memory',
    ]);
    for (const definition of Object.values(tools)) {
      expect(definition).toHaveProperty('inputSchema');
      expect(definition.execute).toBeTypeOf('function');
      expect(definition.description).toBeTypeOf('string');
    }
    expect(JSON.stringify(tools)).not.toContain(apiKey);
    expect(instructions).toBeTypeOf('string');
    expect(instructions.length).toBeGreaterThan(100);
  });

  it.each([
    { options: undefined, deletes: false, namespaces: false },
    { options: { allowDeletes: false, namespaceTools: false }, deletes: false, namespaces: false },
    { options: { allowDeletes: true }, deletes: true, namespaces: false },
    { options: { namespaceTools: true }, deletes: false, namespaces: true },
    { options: { allowDeletes: true, namespaceTools: true }, deletes: true, namespaces: true },
  ])('exposes only the tools enabled by $options in both APIs', async ({ options, deletes, namespaces }) => {
    for (const tools of [
      createRedisAgentMemoryTools(serverURL, 'store-1', apiKey, undefined, options),
      new RedisAgentMemory(serverURL, 'store-1', apiKey, undefined, options),
    ]) {
      expect(tools.search_memories).toBeDefined();
      for (const name of ['delete_memories', 'delete_session_event', 'delete_session_memory']) {
        expect(tools[name] !== undefined).toBe(deletes);
      }
      for (const name of ['list_namespaces', 'get_namespace', 'create_namespace', 'update_namespace', 'move_memories']) {
        expect(tools[name] !== undefined).toBe(namespaces);
      }
      expect(tools.delete_namespace !== undefined).toBe(deletes && namespaces);
      expect(await run(tools, 'get_memory_context', {})).toHaveProperty('allowDeletes', deletes);
    }
  });

  it('uses environment configuration when positional connection arguments are omitted', async () => {
    vi.stubEnv('AGENT_MEMORY_URL', 'https://environment.example.test');
    vi.stubEnv('AGENT_MEMORY_STORE_ID', 'environment-store');
    vi.stubEnv('AGENT_MEMORY_API_KEY', 'environment-key');
    const http = transport({ body: { items: [] } });
    vi.stubGlobal('fetch', http.fetch);

    await run(createRedisAgentMemoryTools(), 'search_memories', {});

    const { request } = http.requests[0]!;
    expect(request.url).toBe('https://environment.example.test/v1/stores/environment-store/long-term-memory/search');
    expect(request.headers.get('authorization')).toBe('Bearer environment-key');
  });

  it('uses positional connection arguments ahead of environment configuration and copies scope', async () => {
    vi.stubEnv('AGENT_MEMORY_URL', 'https://environment.example.test');
    vi.stubEnv('AGENT_MEMORY_STORE_ID', 'environment-store');
    vi.stubEnv('AGENT_MEMORY_API_KEY', 'environment-key');
    const http = transport({ body: { items: [] } });
    vi.stubGlobal('fetch', http.fetch);
    const scope = { userId: 'user-1', sessionId: 'session-1' };
    const tools = createRedisAgentMemoryTools(serverURL, 'store-1', apiKey, scope);
    scope.userId = 'changed-user';
    scope.sessionId = 'changed-session';

    await run(tools, 'search_memories', {});

    const { request, body } = http.requests[0]!;
    expect(request.url).toBe(`${serverURL}/v1/stores/store-1/long-term-memory/search`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(body.filter).toEqual({ ownerId: { eq: 'user-1' } });
    const context = await run(tools, 'get_memory_context', {});
    expect(context).toMatchObject({ userId: 'user-1', sessionId: 'session-1' });
    expect(context).not.toHaveProperty('ownerId');
  });

  it('uses the production endpoint when no URL is provided', async () => {
    vi.stubEnv('AGENT_MEMORY_URL', undefined);
    const http = transport({ body: { items: [] } });
    vi.stubGlobal('fetch', http.fetch);

    await run(createRedisAgentMemoryTools(undefined, 'store-1', apiKey), 'search_memories', {});

    expect(http.requests[0]!.request.url).toBe('https://gcp-us-east4.memory.redis.io/v1/stores/store-1/long-term-memory/search');
  });

  it('fails at construction when required credentials are missing', () => {
    vi.stubEnv('AGENT_MEMORY_API_KEY', undefined);
    vi.stubEnv('AGENT_MEMORY_STORE_ID', undefined);
    expect(() => createRedisAgentMemoryTools(serverURL, 'store-1')).toThrow('AGENT_MEMORY_API_KEY');
    expect(() => createRedisAgentMemoryTools(serverURL, undefined, apiKey)).toThrow('AGENT_MEMORY_STORE_ID');
  });

  it.each([0, -1, NaN, Infinity])('rejects an invalid request timeout of %s', timeoutMs => {
    expect(() => createRedisAgentMemoryTools(serverURL, 'store-1', apiKey, undefined, { timeoutMs })).toThrow('timeoutMs');
  });

  it('aborts a stalled HTTP request after the configured timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      receivedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    };
    const tools = toolsWith(fetch, {}, { timeoutMs: 20 });

    await expect(run(tools, 'search_memories', {})).rejects.toMatchObject({ code: 'IRIS_REQUEST_FAILED' });
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toHaveProperty('name', 'TimeoutError');
  });

  it('uses SDK HTTP serialization and preserves search pagination and records', async () => {
    const http = transport({ body: { items: [memory()], nextPageToken: 'next-page' } });
    const result = await run(toolsWith(http.fetch), 'search_memories', {
      text: 'communication preferences', limit: 5, pageToken: 'previous-page',
      filter: { createdAt: { gte: '2026-09-01T00:00:00Z' } },
    });
    expect(http.requests).toHaveLength(1);
    const { request, body } = http.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${serverURL}/v1/stores/store-1/long-term-memory/search`);
    expect(request.headers.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(body).toMatchObject({
      text: 'communication preferences', limit: 5, pageToken: 'previous-page',
      filter: { createdAt: { gte: '2026-09-01T00:00:00.000Z' } },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'memory-1', text: 'Prefers concise replies.' });
    expect(new Date(result.items[0].createdAt).toISOString()).toBe(timestamp);
    expect(result.nextPageToken).toBe('next-page');
  });

  it('maps user scope to the owner filter while retaining memories from other sessions', async () => {
    const http = transport({ body: { items: [memory()] } });
    await run(toolsWith(http.fetch, { userId: 'user-1', sessionId: 'current-session' }),
      'search_memories', { text: 'preferences', filter: { topics: { in: ['preferences'] } } });
    expect(http.requests[0]!.body.filter).toEqual({
      ownerId: { eq: 'user-1' }, topics: { in: ['preferences'] },
    });
    expect(http.requests[0]!.body.filterOp ?? 'all').toBe('all');
  });

  it('uses the scoped user ID as the owner when listing sessions', async () => {
    const http = transport({ body: { items: ['session-1'], total: 1 } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });

    const result = await run(tools, 'list_sessions', {});

    expect(result.items).toEqual(['session-1']);
    const query = new URL(http.requests[0]!.request.url).searchParams;
    expect(query.get('filterOwnerId')).toBe('user-1');
    expect(query.has('userId')).toBe(false);
  });

  it('limits namespace administration to personal namespaces owned by the scoped user', async () => {
    const http = transport({ body: { items: [namespace()] } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' }, { namespaceTools: true });

    const result = await run(tools, 'list_namespaces', {});

    expect(result.items[0]).toMatchObject({ namespaceId: 'root-1', ownerId: 'user-1' });
    const query = new URL(http.requests[0]!.request.url).searchParams;
    expect(query.get('ownerId')).toBe('user-1');
    expect(query.get('scope')).toBe('PERSONAL');
    expect(query.has('userId')).toBe(false);
  });

  it('rejects an OR search that would bypass an enforced owner filter', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'search_memories', {
      text: 'preferences', filterOp: 'any', filter: { topics: { eq: 'preferences' } },
    })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('rejects a conflicting explicit owner before issuing a request', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'search_memories', {
      filter: { ownerId: { eq: 'someone-else' } },
    })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('generates UUIDs, fills write scope, and maps partial bulk failures to input records', async () => {
    const http = transport({
      status: 201,
      body: ({ memories }: { memories: Array<{ id: string }> }) => ({
        created: [memories[0]!.id], errors: [{ id: memories[1]!.id, error: 'Unknown custom type' }],
      }),
    });
    const tools = toolsWith(http.fetch, { userId: 'user-1', sessionId: 'session-1' });
    const result = await run(tools, 'create_memories', { memories: [
      { text: 'Prefers concise replies.', memoryType: 'communication', attributes: { concise: true } },
      { text: 'Other custom data.', memoryType: 'custom-type' },
    ] });
    const ids = http.requests[0]!.body.memories.map((record: { id: string }) => record.id);
    expect(new Set(ids).size).toBe(2);
    expect(result).toEqual({
      memoryIds: ids,
      created: [ids[0]],
      errors: [{ id: ids[1], error: 'Unknown custom type' }],
    });
    expect(http.requests[0]!.body.memories).toEqual([
      { id: expect.stringMatching(uuidV4), text: 'Prefers concise replies.', memoryType: 'communication', attributes: { concise: true }, ownerId: 'user-1', sessionId: 'session-1' },
      { id: expect.stringMatching(uuidV4), text: 'Other custom data.', memoryType: 'custom-type', ownerId: 'user-1', sessionId: 'session-1' },
    ]);
    expect(http.requests).toHaveLength(1);
  });

  it('generates fresh UUIDs on every invocation and never uses caller-supplied IDs', async () => {
    const response = {
      status: 201,
      body: ({ memories }: { memories: Array<{ id: string }> }) => ({ created: memories.map(memory => memory.id) }),
    };
    const http = transport(response, response);
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    const input = { memories: [{ id: 'model-guessed-id', text: 'Prefers TypeScript.' }] };

    const parsedResult = await run(tools, 'create_memories', input);
    const directResult = await tools.create_memories!.execute!(input, {
      toolCallId: 'direct-call', messages: [], context: {},
    });

    const ids = http.requests.map(({ body }) => body.memories[0].id);
    expect(ids).toEqual([expect.stringMatching(uuidV4), expect.stringMatching(uuidV4)]);
    expect(new Set(ids).size).toBe(2);
    expect([parsedResult, directResult]).toEqual(ids.map(id => ({ memoryIds: [id], created: [id] })));
    expect(input.memories[0]!.id).toBe('model-guessed-id');
  });

  it('checks ownership when a model guesses a direct memory ID', async () => {
    const http = transport({ body: memory({ ownerId: 'someone-else' }) });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'get_memory', { memoryId: 'memory-1' })).rejects.toThrow();
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET']);
  });

  it('preflights every memory before deleting a scoped batch', async () => {
    const http = transport(
      { body: memory({ id: 'mine' }) },
      { body: memory({ id: 'theirs', ownerId: 'someone-else' }) },
    );
    const tools = toolsWith(http.fetch, { userId: 'user-1' }, { allowDeletes: true });
    await expect(run(tools, 'delete_memories', { memoryIds: ['mine', 'theirs'] })).rejects.toThrow();
    expect(http.requests).toHaveLength(2);
    expect(http.requests.every(({ request }) => request.method === 'GET')).toBe(true);
  });

  it.each(['create_memories', 'add_session_event', 'update_memory'])(
    'prevents %s from placing data in another owner’s namespace hierarchy', async name => {
      const http = transport(
        ...(name === 'update_memory' ? [{ body: memory() }] : []),
        { body: { namespace: namespace({ namespaceId: 'child-1', parentId: 'root-1', ownerId: undefined }) } },
        { body: { namespace: namespace({ ownerId: 'someone-else' }) } },
      );
      const tools = toolsWith(http.fetch, { userId: 'user-1' });
      const placement = { namespaceRef: { namespaceId: 'child-1' } };
      const input = name === 'create_memories'
        ? { memories: [{ text: 'Private preferences.', ...placement }] }
        : name === 'add_session_event'
          ? { actorId: 'user-1', role: 'USER', content: [{ text: 'Private preferences.' }], ...placement }
          : { memoryId: 'memory-1', changes: placement };
      await expect(run(tools, name, input)).rejects.toThrow();
      expect(http.requests).toHaveLength(name === 'update_memory' ? 3 : 2);
      expect(http.requests.every(({ request }) => request.method === 'GET')).toBe(true);
      expect(http.requests.at(-1)!.request.url).toContain('/namespaces/root-1');
    },
  );

  it('allows placement in the owner’s personal namespace and validates it once per bulk write', async () => {
    const http = transport(
      { body: { namespace: namespace() } },
      {
        status: 201,
        body: ({ memories }: { memories: Array<{ id: string }> }) => ({ created: memories.map(memory => memory.id) }),
      },
    );
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    const records = ['Prefers TypeScript.', 'Prefers concise replies.'].map(text => ({
      text, namespaceRef: { namespaceId: 'root-1' },
    }));
    const result = await run(tools, 'create_memories', { memories: records });
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET', 'POST']);
    expect(http.requests[1]!.body.memories).toEqual(records.map(record => ({
      ...record, id: expect.stringMatching(uuidV4), ownerId: 'user-1',
    })));
    const ids = http.requests[1]!.body.memories.map((record: { id: string }) => record.id);
    expect(result).toEqual({ memoryIds: ids, created: ids });
  });

  it('prevents reading a session outside the fixed session scope', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { userId: 'user-1', sessionId: 'session-1' });
    await expect(run(tools, 'get_session_memory', { sessionId: 'another-session' })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('starts a session with a USER event and returns the server-generated ID', async () => {
    const http = transport({ status: 201, body: { event: event({ sessionId: 'generated-session' }) } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    const result = await run(tools, 'start_session', { actorId: 'user-1', text: 'Hello.' });
    expect(result.event.sessionId).toBe('generated-session');
    expect(http.requests[0]!.body).toMatchObject({
      actorId: 'user-1', role: 'USER', content: [{ text: 'Hello.' }],
    });
    expect(http.requests[0]!.body.sessionId).toBeUndefined();
    expect(Number.isNaN(Date.parse(http.requests[0]!.body.createdAt))).toBe(false);
  });

  it('requires a newly generated scoped session to start with its owner as a USER', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { userId: 'user-1' });
    await expect(run(tools, 'start_session', { actorId: 'another-user', text: 'Hello.' })).rejects.toThrow();
    await expect(run(tools, 'add_session_event', {
      actorId: 'user-1', role: 'ASSISTANT', content: [{ text: 'Hello.' }],
    })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('uses the assistant as event actor while retaining the human session owner', async () => {
    const assistantEvent = event({ actorId: 'assistant-1', role: 'ASSISTANT' });
    const http = transport(
      { body: { sessionId: 'session-1', ownerId: 'user-1', events: [] } },
      { status: 201, body: { event: assistantEvent } },
    );
    const tools = toolsWith(http.fetch, { userId: 'user-1', sessionId: 'session-1' });
    const result = await run(tools, 'add_session_event', {
      actorId: 'assistant-1', role: 'ASSISTANT', content: [{ text: 'Hello.' }],
      createdAt: '2026-09-25T14:34:56+02:00', metadata: { source: 'test' },
    });
    expect(result.event.actorId).toBe('assistant-1');
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET', 'POST']);
    expect(http.requests[1]!.body).toMatchObject({
      actorId: 'assistant-1', role: 'ASSISTANT', sessionId: 'session-1',
      createdAt: timestamp, metadata: { source: 'test' },
    });
  });

  it('does not expose upstream response bodies or credentials in thrown errors', async () => {
    const privateBody = `private-memory-content ${apiKey}`;
    const http = transport({ status: 500, body: { message: privateBody } });
    let failure: unknown;
    try { await run(toolsWith(http.fetch), 'search_memories', { text: 'preferences' }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const serialized = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('private-memory-content');
    expect(http.requests).toHaveLength(1);
  });

  it('propagates cancellation to the underlying HTTP request', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      receivedSignal = request.signal;
      resolveStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    };
    const result = run(toolsWith(fetch), 'search_memories', { text: 'preferences' }, controller.signal);
    const rejected = expect(result).rejects.toThrow();
    await started;
    controller.abort();
    await rejected;
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('runs an AI SDK 7 tool loop and separates intermediate text from the final memory-informed reply', async () => {
    const http = transport({ body: { items: [memory()] } });
    const tools = toolsWith(http.fetch, { userId: 'user-1' }, { namespaceTools: true });
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    };
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async options => {
        calls += 1;
        if (calls === 1) {
          expect(options.tools?.some(tool => tool.name === 'search_memories')).toBe(true);
          expect(options.tools?.some(tool => tool.name === 'create_namespace')).toBe(true);
          expect(options.tools?.find(tool => tool.name === 'create_memories')).toMatchObject({
            type: 'function',
            inputSchema: { properties: { memories: { items: {
              properties: expect.not.objectContaining({ id: expect.anything() }),
              required: ['text'],
            } } } },
          });
          expect(options.tools).toHaveLength(Object.keys(tools).length);
          for (const definition of options.tools ?? []) {
            expect(definition.type).toBe('function');
            if (definition.type === 'function') expect(definition.inputSchema.type).toBe('object');
          }
          return {
            content: [
              { type: 'text', text: 'Let me check your saved preferences.' },
              { type: 'tool-call', toolCallId: 'recall-1', toolName: 'search_memories', input: '{"text":"communication preferences"}' },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
          };
        }
        expect(JSON.stringify(options.prompt)).toContain('Prefers concise replies.');
        return {
          content: [{ type: 'text', text: 'I will keep my replies concise.' }],
          finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
        };
      },
    });
    const agent = new ToolLoopAgent({ model, tools, instructions, stopWhen: isStepCount(3) });
    const result = await agent.generate({ prompt: 'How do I prefer you to respond?' });
    expect(result.steps[0]?.text).toBe('Let me check your saved preferences.');
    expect(result.finalStep.text).toBe('I will keep my replies concise.');
    expect(result.steps).toHaveLength(2);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.body.filter).toMatchObject({ ownerId: { eq: 'user-1' } });
    expect(calls).toBe(2);
  });
});
