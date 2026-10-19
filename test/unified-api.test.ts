import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { createRedisAgentMemory, RedisAgentMemoryToolError } from '../src/index.js';

const connection = {
  serverUrl: 'https://memory.example.test',
  storeId: 'store-1',
  apiKey: 'secret-key',
};

afterEach(() => vi.unstubAllGlobals());

describe('createRedisAgentMemory', () => {
  it('constructs tools and fresh request models without network calls', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const configuredModel = new MockLanguageModelV4();
    const memory = createRedisAgentMemory({
      ...connection,
      scope: { userId: 'default-user', sessionId: 'default-session' },
      model: configuredModel,
    });

    const tools = memory.tools();
    const first = memory.model({ assistantId: 'assistant-1' });
    const second = memory.model({ assistantId: 'assistant-1' });

    expect(Object.keys(tools)).toContain('search_memories');
    expect(first).not.toBe(second);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('replaces the whole default scope for tools instead of inheriting omitted fields', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>());
    const defaultScope = { userId: 'default-user', sessionId: 'default-session', namespaceId: 'default-namespace' };
    const overrideScope = { userId: 'other-user' };
    const memory = createRedisAgentMemory({ ...connection, scope: defaultScope });

    const context = await memory.tools({ scope: overrideScope }).get_memory_context!.execute!({}, {
      toolCallId: 'context', messages: [], context: {},
    });

    expect(context).toMatchObject({ userId: 'other-user' });
    expect(context).not.toHaveProperty('sessionId');
    expect(context).not.toHaveProperty('namespaceId');
    expect(defaultScope).toEqual({
      userId: 'default-user', sessionId: 'default-session', namespaceId: 'default-namespace',
    });
    expect(overrideScope).toEqual({ userId: 'other-user' });
  });

  it('supports tools without a model and rejects a missing or invalid request model synchronously', () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>());
    const memory = createRedisAgentMemory({ ...connection, scope: { userId: 'user-1' } });

    expect(memory.tools().search_memories).toBeDefined();
    expect(() => (memory.model as (options: unknown) => unknown)({
      scope: { userId: 'user-1', sessionId: 'session-1' }, assistantId: 'assistant-1',
    })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    expect(() => (memory.model as (options: unknown) => unknown)({
      model: 'provider:model', scope: { userId: 'user-1', sessionId: 'session-1' }, assistantId: 'assistant-1',
    })).toThrow(RedisAgentMemoryToolError);
  });

  it.each([
    ['missing supportedUrls', { specificationVersion: 'v4' }],
    ['coercible non-string specificationVersion', {
      specificationVersion: { toString: (): string => 'v4' }, supportedUrls: {},
    }],
  ])('rejects a near-valid factory model with %s before network or inference', (_name, malformed) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const doGenerate = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const model = {
      provider: 'invalid-test', modelId: 'invalid-model',
      doGenerate, doStream: vi.fn(), ...malformed,
    };

    expect(() => createRedisAgentMemory({
      ...connection,
      // @ts-expect-error Exercise invalid JavaScript consumer input.
      model,
    })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(doGenerate).not.toHaveBeenCalled();
  });

  it.each([
    ['missing supportedUrls', { specificationVersion: 'v4' }],
    ['coercible non-string specificationVersion', {
      specificationVersion: { toString: (): string => 'v4' }, supportedUrls: {},
    }],
  ])('rejects a near-valid call model override with %s before network or inference', (_name, malformed) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const defaultModel = new MockLanguageModelV4();
    const doGenerate = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const memory = createRedisAgentMemory({ ...connection, model: defaultModel });

    expect(() => memory.model({
      scope: { userId: 'user-1', sessionId: 'session-1' },
      assistantId: 'assistant-1',
      // @ts-expect-error Exercise invalid JavaScript consumer input.
      model: {
        provider: 'invalid-test', modelId: 'invalid-model',
        doGenerate, doStream: vi.fn(), ...malformed,
      },
    })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(doGenerate).not.toHaveBeenCalled();
    expect(defaultModel.doGenerateCalls).toHaveLength(0);
  });

  it('uses defaults for undefined call options and invokes a supplied model override', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>());
    const result = {
      content: [{ type: 'text' as const, text: 'OK' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    };
    const defaultModel = new MockLanguageModelV4({ doGenerate: async () => result });
    const overrideModel = new MockLanguageModelV4({ doGenerate: async () => result });
    Object.defineProperty(defaultModel, 'modelId', { value: 'default-model' });
    Object.defineProperty(overrideModel, 'modelId', { value: 'override-model' });
    const defaultScope = { userId: 'default-user', sessionId: 'default-session' };
    const memory = createRedisAgentMemory({ ...connection, scope: defaultScope, model: defaultModel });

    const defaultTools = memory.tools({ scope: undefined });
    const context = await defaultTools.get_memory_context!.execute!({}, {
      toolCallId: 'context', messages: [], context: {},
    });
    const first = memory.model({ model: undefined, scope: undefined, historyMode: 'application', recording: false });
    const second = memory.model({
      model: overrideModel,
      scope: { userId: 'other-user', sessionId: 'other-session' },
      historyMode: 'application',
      recording: false,
    });
    const params = { prompt: [{ role: 'system' as const, content: 'Application rule.' }] };
    await first.doGenerate(params);
    await second.doGenerate(params);

    expect(first).not.toBe(second);
    expect(first.modelId).toBe(defaultModel.modelId);
    expect(second.modelId).toBe(overrideModel.modelId);
    expect(defaultModel.doGenerateCalls).toHaveLength(1);
    expect(overrideModel.doGenerateCalls).toHaveLength(1);
    expect(context).toMatchObject(defaultScope);
    expect(defaultScope).toEqual({ userId: 'default-user', sessionId: 'default-session' });
  });

  it('replaces the whole default scope for models', async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(await request.json() as Record<string, unknown>);
      return Response.json({ items: [] });
    }));
    const base = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'text', text: 'OK' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }) });
    const memory = createRedisAgentMemory({
      ...connection,
      model: base,
      scope: { userId: 'default-user', sessionId: 'default-session', namespaceId: 'default-namespace' },
    });

    expect(() => memory.model({
      scope: { userId: 'other-user' },
      assistantId: 'assistant',
    })).toThrow('scope.sessionId');

    await memory.model({
      scope: { userId: 'other-user' },
      historyMode: 'application',
      recording: false,
    }).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Question.' }] }] });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ filter: { ownerId: { eq: 'other-user' } } });
    expect(requests[0]).not.toHaveProperty('filter.sessionId');
    expect(requests[0]).not.toHaveProperty('filter.namespaceRef');
  });
});
