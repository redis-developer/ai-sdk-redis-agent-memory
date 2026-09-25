import { describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { RedisAgentMemory, createIrisMemoryTools, irisMemoryInstructions } from '../src/index.js';

const apiKey = 'test-secret-iris-key';
const serverURL = 'https://iris.example.test';
const timestamp = '2026-09-25T12:34:56.000Z';

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
    requests.push({ request, body: text ? JSON.parse(text) : undefined });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected HTTP request: ${request.method} ${request.url}`);
    return new Response(JSON.stringify(response.body), {
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
  return definition.execute(parsed, { toolCallId: 'test-call', messages: [], abortSignal });
}

function toolsWith(fetch: typeof globalThis.fetch, options: ConstructorParameters<typeof RedisAgentMemory>[1] = {}) {
  return new RedisAgentMemory(apiKey, { storeId: 'store-1', serverURL, fetch, ...options });
}

describe('RedisAgentMemory toolset', () => {
  it('can be passed directly as a ToolSet and exposes no enumerable client or credentials', () => {
    const tools: ToolSet = toolsWith(transport().fetch);
    expect(Object.keys(tools)).toEqual(expect.arrayContaining([
      'get_memory_context', 'start_session', 'add_session_event', 'get_session_event',
      'get_session_memory', 'list_sessions', 'create_memories', 'get_memory',
      'search_memories', 'update_memory', 'delete_memories',
      'delete_session_event', 'delete_session_memory',
    ]));
    for (const definition of Object.values(tools)) {
      expect(definition).toHaveProperty('inputSchema');
      expect(definition.execute).toBeTypeOf('function');
      expect(definition.description).toBeTypeOf('string');
    }
    expect(JSON.stringify(tools)).not.toContain(apiKey);
    expect(irisMemoryInstructions).toBeTypeOf('string');
    expect(irisMemoryInstructions.length).toBeGreaterThan(100);
  });

  it('provides the factory API and removes destructive tools when disabled', () => {
    const tools = createIrisMemoryTools(apiKey, {
      storeId: 'store-1', serverURL, fetch: transport().fetch, allowDeletes: false,
    });
    expect(tools.search_memories).toBeDefined();
    expect(tools.delete_memories).toBeUndefined();
    expect(tools.delete_session_event).toBeUndefined();
    expect(tools.delete_session_memory).toBeUndefined();
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

  it('enforces owner scope while retaining memories from other sessions', async () => {
    const http = transport({ body: { items: [memory()] } });
    await run(toolsWith(http.fetch, { scope: { ownerId: 'user-1', sessionId: 'current-session' } }),
      'search_memories', { text: 'preferences', filter: { topics: { in: ['preferences'] } } });
    expect(http.requests[0]!.body.filter).toEqual({
      ownerId: { eq: 'user-1' }, topics: { in: ['preferences'] },
    });
    expect(http.requests[0]!.body.filterOp ?? 'all').toBe('all');
  });

  it('rejects an OR search that would bypass an enforced owner filter', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' } });
    await expect(run(tools, 'search_memories', {
      text: 'preferences', filterOp: 'any', filter: { topics: { eq: 'preferences' } },
    })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('rejects a conflicting explicit owner before issuing a request', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' } });
    await expect(run(tools, 'search_memories', {
      filter: { ownerId: { eq: 'someone-else' } },
    })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('fills write scope, permits custom memory types, and preserves partial bulk failures', async () => {
    const response = { created: ['memory-1'], errors: [{ id: 'memory-2', error: 'Unknown custom type' }] };
    const http = transport({ body: response, status: 201 });
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1', sessionId: 'session-1' } });
    const result = await run(tools, 'create_memories', { memories: [
      { id: 'memory-1', text: 'Prefers concise replies.', memoryType: 'communication', attributes: { concise: true } },
      { id: 'memory-2', text: 'Other custom data.', memoryType: 'custom-type' },
    ] });
    expect(result).toEqual(response);
    expect(http.requests[0]!.body.memories).toEqual([
      { id: 'memory-1', text: 'Prefers concise replies.', memoryType: 'communication', attributes: { concise: true }, ownerId: 'user-1', sessionId: 'session-1' },
      { id: 'memory-2', text: 'Other custom data.', memoryType: 'custom-type', ownerId: 'user-1', sessionId: 'session-1' },
    ]);
    expect(http.requests).toHaveLength(1);
  });

  it('checks ownership when a model guesses a direct memory ID', async () => {
    const http = transport({ body: memory({ ownerId: 'someone-else' }) });
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' } });
    await expect(run(tools, 'get_memory', { memoryId: 'memory-1' })).rejects.toThrow();
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET']);
  });

  it('preflights every memory before deleting a scoped batch', async () => {
    const http = transport(
      { body: memory({ id: 'mine' }) },
      { body: memory({ id: 'theirs', ownerId: 'someone-else' }) },
    );
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' } });
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
      const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' } });
      const placement = { namespaceRef: { namespaceId: 'child-1' } };
      const input = name === 'create_memories'
        ? { memories: [{ id: 'memory-1', text: 'Private preferences.', ...placement }] }
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
      { status: 201, body: { created: ['memory-1', 'memory-2'] } },
    );
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' } });
    const records = ['memory-1', 'memory-2'].map(id => ({
      id, text: 'Private preferences.', namespaceRef: { namespaceId: 'root-1' },
    }));
    await expect(run(tools, 'create_memories', { memories: records })).resolves.toEqual({
      created: ['memory-1', 'memory-2'],
    });
    expect(http.requests.map(({ request }) => request.method)).toEqual(['GET', 'POST']);
    expect(http.requests[1]!.body.memories).toEqual(records.map(record => ({ ...record, ownerId: 'user-1' })));
  });

  it('prevents reading a session outside the fixed session scope', async () => {
    const http = transport();
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1', sessionId: 'session-1' } });
    await expect(run(tools, 'get_session_memory', { sessionId: 'another-session' })).rejects.toThrow();
    expect(http.requests).toHaveLength(0);
  });

  it('starts a session with a USER event and returns the server-generated ID', async () => {
    const http = transport({ status: 201, body: { event: event({ sessionId: 'generated-session' }) } });
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' } });
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
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' } });
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
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1', sessionId: 'session-1' } });
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

  it('runs in a real ToolLoopAgent and sends memory results into the next model step', async () => {
    const http = transport({ body: { items: [memory()] } });
    const tools = toolsWith(http.fetch, { scope: { ownerId: 'user-1' }, namespaceTools: true });
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    };
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async options => {
        calls += 1;
        if (calls === 1) {
          expect(options.tools?.some(tool => tool.name === 'search_memories')).toBe(true);
          expect(options.tools?.some(tool => tool.name === 'create_namespace')).toBe(true);
          expect(options.tools).toHaveLength(Object.keys(tools).length);
          for (const definition of options.tools ?? []) {
            expect(definition.type).toBe('function');
            if (definition.type === 'function') expect(definition.inputSchema.type).toBe('object');
          }
          return {
            content: [{ type: 'tool-call', toolCallId: 'recall-1', toolName: 'search_memories', input: '{"text":"communication preferences"}' }],
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
    const agent = new ToolLoopAgent({ model, tools, instructions: irisMemoryInstructions });
    const result = await agent.generate({ prompt: 'How do I prefer you to respond?' });
    expect(result.text).toBe('I will keep my replies concise.');
    expect(result.steps).toHaveLength(2);
    expect(http.requests).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
