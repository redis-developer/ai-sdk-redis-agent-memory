import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent, isStepCount, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  createRedisAgentMemory,
  type RedisAgentMemoryOptions, type RedisAgentMemoryScope,
} from '../src/index.js';

const serverURL = 'https://context.example.test';
const apiKey = 'fake-context-test-key';
const timestamp = '2026-09-29T12:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function run(tools: ToolSet, name: string, input: unknown = {}): Promise<any> {
  const definition = tools[name];
  if (!definition?.execute) throw new Error(`Missing executable tool: ${name}`);
  const schema = definition.inputSchema as { parseAsync(value: unknown): Promise<unknown> };
  return definition.execute(await schema.parseAsync(input), {
    toolCallId: 'context-test', messages: [], context: {},
  });
}

function transport(body: unknown = { items: [] }) {
  const requests: Array<{ request: Request; body: any }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    requests.push({ request, body: text ? JSON.parse(text) : undefined });
    return Response.json(body);
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, fetch };
}

function makeTools(
  serverUrl?: string,
  storeId?: string,
  key?: string,
  scope: RedisAgentMemoryScope = {},
  options: RedisAgentMemoryOptions = {},
) {
  return createRedisAgentMemory({ ...options, serverUrl, storeId, apiKey: key, scope }).tools();
}

const creators = [
  {
    name: 'unified factory',
    create: (scope?: RedisAgentMemoryScope, options?: RedisAgentMemoryOptions) =>
      makeTools(serverURL, 'store-1', apiKey, scope, options),
    fromEnvironment: () => makeTools(),
  },
];

it('preserves tool-map typing and withContext narrowing', async () => {
  const instance = makeTools(serverURL, 'store-1', apiKey);
  const tools: ToolSet = instance;

  expect(tools).toBe(instance);
  expect(await run(instance.withContext({ userId: 'user-1' }), 'get_memory_context'))
    .toHaveProperty('userId', 'user-1');
  if (false) {
    // @ts-expect-error withContext is a method, not an AI SDK tool definition.
    instance.withContext.execute;
  }
});

describe.each(creators)('withContext via $name', ({ create, fromEnvironment }) => {
  it('copies context, fills missing fields, and leaves the parent unchanged', async () => {
    const initial = { userId: 'user-1' };
    const parent = create(initial);
    initial.userId = 'changed-user';
    const context = { sessionId: 'session-1' };
    const scoped = parent.withContext(context);
    context.sessionId = 'changed-session';
    const nested = scoped.withContext({ userId: 'user-1', sessionId: undefined, namespaceId: 'notes-1' });

    expect(scoped).not.toBe(parent);
    expect(await run(parent, 'get_memory_context')).toMatchObject({ userId: 'user-1' });
    expect(await run(parent, 'get_memory_context')).not.toHaveProperty('sessionId');
    expect(await run(scoped, 'get_memory_context')).toMatchObject({ userId: 'user-1', sessionId: 'session-1' });
    expect(await run(scoped, 'get_memory_context')).not.toHaveProperty('namespaceId');
    expect(await run(nested, 'get_memory_context')).toMatchObject({
      userId: 'user-1', sessionId: 'session-1', namespaceId: 'notes-1',
    });
  });

  it.each([
    ['userId', 'user-1', 'user-2'],
    ['sessionId', 'session-1', 'session-2'],
    ['namespace', 'personal', 'shared'],
    ['namespaceId', 'notes-1', 'notes-2'],
  ] as const)('preserves initial and derived fixed %s boundaries', async (field, value, conflicting) => {
    for (const parent of [create({ [field]: value }), create().withContext({ [field]: value })]) {
      expect(() => parent.withContext({ [field]: conflicting })).toThrow();
      const same = parent.withContext({ [field]: value });
      const omitted = parent.withContext({ [field]: undefined });
      expect(await run(same, 'get_memory_context')).toHaveProperty(field, value);
      expect(await run(omitted, 'get_memory_context')).toHaveProperty(field, value);
    }
  });

  it('validates merged namespace selectors and newly supplied identifiers before making requests', () => {
    const http = transport();
    expect(() => create({ namespace: 'legacy' }).withContext({ namespaceId: 'notes-1' })).toThrow();
    expect(() => create({ namespaceId: 'notes-1' }).withContext({ namespace: 'legacy' })).toThrow();
    expect(() => create().withContext({ namespace: 'legacy', namespaceId: 'notes-1' })).toThrow();
    expect(() => create({}, { namespaceTools: true }).withContext({ namespace: 'legacy' })).toThrow();
    for (const scope of [{ userId: '' }, { sessionId: 'invalid/session' }, { namespaceId: '' }, { namespace: ' ' }]) {
      expect(() => create().withContext(scope)).toThrow();
    }
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('retains enabled tools and hides withContext from enumeration and object spread', async () => {
    const options = { allowDeletes: true, namespaceTools: true };
    const parent = create({}, options);
    options.allowDeletes = false;
    options.namespaceTools = false;
    const scoped = parent.withContext({ userId: 'user-1' });

    expect(Object.keys(scoped)).toEqual(Object.keys(parent));
    expect(scoped.delete_memories).toBeDefined();
    expect(scoped.delete_namespace).toBeDefined();
    expect(scoped.list_namespaces).toBeDefined();
    expect(await run(scoped, 'get_memory_context')).toHaveProperty('allowDeletes', true);
    for (const tools of [parent, scoped, scoped.withContext({ sessionId: 'session-1' })]) {
      expect(tools.withContext).toBeTypeOf('function');
      expect(Object.keys(tools)).not.toContain('withContext');
      expect({ ...tools }).not.toHaveProperty('withContext');
      for (const definition of Object.values(tools)) {
        expect(definition).toHaveProperty('inputSchema');
        expect(definition).toHaveProperty('execute', expect.any(Function));
      }
      expect(JSON.stringify(tools)).not.toContain(apiKey);
    }
    const defaults = create().withContext({ userId: 'user-1' });
    expect(defaults.delete_memories).toBeUndefined();
    expect(defaults.list_namespaces).toBeUndefined();
  });

  it('retains the resolved connection when environment configuration changes', async () => {
    vi.stubEnv('AGENT_MEMORY_URL', serverURL);
    vi.stubEnv('AGENT_MEMORY_STORE_ID', 'store-1');
    vi.stubEnv('AGENT_MEMORY_API_KEY', apiKey);
    const parent = fromEnvironment();
    vi.stubEnv('AGENT_MEMORY_URL', 'https://other.example.test');
    vi.stubEnv('AGENT_MEMORY_STORE_ID', 'other-store');
    vi.stubEnv('AGENT_MEMORY_API_KEY', undefined);
    const http = transport();

    await run(parent.withContext({ userId: 'user-1' }), 'search_memories');

    expect(http.requests[0]!.request.url).toBe(`${serverURL}/v1/stores/store-1/long-term-memory/search`);
    expect(http.requests[0]!.request.headers.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(http.requests[0]!.body.filter).toEqual({ ownerId: { eq: 'user-1' } });
  });

  it('enforces derived scope on tool inputs and returned records', async () => {
    const http = transport({
      id: 'foreign-memory', text: 'Private.', ownerId: 'user-2',
      createdAt: timestamp, updatedAt: timestamp,
    });
    const scoped = create().withContext({ userId: 'user-1', sessionId: 'session-1' });

    await expect(run(scoped, 'search_memories', { filter: { ownerId: { eq: 'user-2' } } })).rejects.toThrow();
    await expect(run(scoped, 'get_session_memory', { sessionId: 'session-2' })).rejects.toThrow();
    expect(http.fetch).not.toHaveBeenCalled();
    await expect(run(scoped, 'get_memory', { memoryId: 'foreign-memory' })).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps sibling owners and sessions isolated while another conversation awaits HTTP', async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
    const writes: Array<{ ownerId: string; sessionId: string; id: string }> = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'GET') {
        const first = request.url.endsWith('/memory-1');
        if (first) {
          resolveStarted();
          await firstResponse;
        }
        return Response.json({
          id: first ? 'memory-1' : 'memory-2', text: 'Conversation preference.',
          ownerId: first ? 'user-1' : 'user-2', createdAt: timestamp, updatedAt: timestamp,
        });
      }
      const { memories } = await request.json() as { memories: typeof writes };
      writes.push(...memories);
      return Response.json({ created: memories.map(memory => memory.id) }, { status: 201 });
    }));
    const parent = create();
    const first = parent.withContext({ userId: 'user-1', sessionId: 'session-1' });
    const firstRead = run(first, 'get_memory', { memoryId: 'memory-1' });
    await started;
    const second = parent.withContext({ userId: 'user-2', sessionId: 'session-2' });
    try {
      expect(await run(second, 'get_memory', { memoryId: 'memory-2' })).toHaveProperty('ownerId', 'user-2');
    } finally {
      releaseFirst();
    }
    expect(await firstRead).toHaveProperty('ownerId', 'user-1');
    await Promise.all([
      run(first, 'create_memories', { memories: [{ text: 'First conversation.' }] }),
      run(second, 'create_memories', { memories: [{ text: 'Second conversation.' }] }),
    ]);

    expect(writes).toHaveLength(2);
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: 'user-1', sessionId: 'session-1' }),
      expect.objectContaining({ ownerId: 'user-2', sessionId: 'session-2' }),
    ]));
    expect(await run(parent, 'get_memory_context')).not.toHaveProperty('userId');
    expect(await run(parent, 'get_memory_context')).not.toHaveProperty('sessionId');
  });

  it('preserves the request timeout for derived tools', async () => {
    let receivedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      receivedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    }));
    const scoped = create({}, { timeoutMs: 20 }).withContext({ userId: 'user-1' });

    await expect(run(scoped, 'search_memories')).rejects.toMatchObject({ code: 'IRIS_REQUEST_FAILED' });
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toHaveProperty('name', 'TimeoutError');
  });

  it('works directly in a ToolLoopAgent without advertising withContext as a tool', async () => {
    const http = transport();
    const scoped = create().withContext({ userId: 'user-1', sessionId: 'session-1' });
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    };
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async options => {
        expect(options.tools?.map(tool => tool.name)).toEqual(Object.keys(scoped));
        if (calls++ === 0) return {
          content: [{ type: 'tool-call', toolCallId: 'recall-1', toolName: 'search_memories', input: '{}' }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
        };
        return {
          content: [{ type: 'text', text: 'No saved preferences yet.' }],
          finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
        };
      },
    });
    const agent = new ToolLoopAgent({ model, tools: scoped, stopWhen: isStepCount(3) });

    const result = await agent.generate({ prompt: 'Recall my preferences.' });

    expect(result.finalStep.text).toBe('No saved preferences yet.');
    expect(result.steps).toHaveLength(2);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.body.filter).toEqual({ ownerId: { eq: 'user-1' } });
  });
});
