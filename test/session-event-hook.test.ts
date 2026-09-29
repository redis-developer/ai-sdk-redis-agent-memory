import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolLoopAgent, type ModelMessage } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import {
  RedisAgentMemory, RedisAgentMemoryToolError, createRedisAgentMemoryTools,
  type SessionEventHook, type SessionEventHookOptions, type SessionEventHookInput,
  type SessionHookEvent, type SessionEventHookErrorContext,
} from '../src/index.js';

const serverURL = 'https://hook.example.test';
const apiKey = 'fake-hook-test-key';
const scope = { userId: 'user-1', sessionId: 'session-1' };
const timestamp = '2026-09-29T12:00:00.000Z';
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

afterEach(() => vi.unstubAllGlobals());

type WrittenEvent = {
  sessionId: string;
  actorId: string;
  role: 'USER' | 'ASSISTANT';
  content: Array<{ text: string }>;
};

/** Run the real Redis SDK against a stateful HTTP boundary, including session ownership checks. */
function transport(options: {
  failRole?: WrittenEvent['role'];
  owners?: Array<[string, string]>;
  beforeWrite?: (event: WrittenEvent) => Promise<void> | void;
} = {}) {
  const owners = new Map(options.owners);
  const writes: WrittenEvent[] = [];
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    if (request.method === 'GET') {
      const sessionId = new URL(request.url).pathname.split('/').at(-1)!;
      const ownerId = owners.get(sessionId);
      return ownerId
        ? Response.json({ sessionId, ownerId, events: [] })
        : Response.json({ title: 'Missing session', type: '/errors/resource-not-found' }, { status: 404 });
    }
    const event = await request.json() as WrittenEvent;
    writes.push(event);
    await options.beforeWrite?.(event);
    if (event.role === options.failRole) return Response.json({
      title: 'Private upstream failure', type: '/errors/insufficient-permissions',
      detail: `${apiKey}: private conversation content`,
    }, { status: 403, headers: { 'x-private-debug': apiKey } });
    if (!owners.has(event.sessionId)) owners.set(event.sessionId, event.actorId);
    return Response.json({ event: {
      ...event, eventId: `event-${writes.length}`, createdAt: timestamp, systemTimestamp: timestamp,
    } }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetch);
  return { writes, requests, fetch };
}

function tools() {
  return createRedisAgentMemoryTools(serverURL, 'store-1', apiKey, scope);
}

function userInput(messages: readonly ModelMessage[] = [{ role: 'user', content: 'Hello.' }]): SessionEventHookInput<'USER'> {
  return { messages };
}

function assistantInput(text = 'Hello back.'): SessionEventHookInput<'ASSISTANT'> {
  return { finalStep: { text } };
}

describe('createSessionEventHook', () => {
  it('is a typed, non-enumerable helper on constructor, factory, and derived toolsets', () => {
    const constructed = new RedisAgentMemory(serverURL, 'store-1', apiKey, scope);
    const factory = tools();
    const derived = createRedisAgentMemoryTools(serverURL, 'store-1', apiKey).withContext(scope);
    const options: SessionEventHookOptions<'USER'> = { role: 'USER', actorId: 'user-1', onError: vi.fn() };

    for (const memory of [constructed, factory, derived]) {
      const hook: SessionEventHook<'USER'> = memory.createSessionEventHook(options);
      expect(hook).toBeTypeOf('function');
      expect(Object.keys(memory)).not.toContain('createSessionEventHook');
      expect({ ...memory }).not.toHaveProperty('createSessionEventHook');
      for (const value of Object.values(memory)) expect(value).toHaveProperty('execute', expect.any(Function));
      if (false) {
        // @ts-expect-error This application callback factory is not an AI SDK tool.
        memory.createSessionEventHook.execute;
      }
    }
  });

  it('types USER hooks for onStart and ASSISTANT hooks for onEnd', () => {
    const memory = tools();
    const onStart = memory.createSessionEventHook({ role: 'USER', actorId: 'user-1', onError: vi.fn() });
    const onEnd = memory.createSessionEventHook({ role: 'ASSISTANT', actorId: 'assistant-1', onError: vi.fn() });
    const model = new MockLanguageModelV4();
    expect(new ToolLoopAgent({ model, tools: memory, onStart, onEnd })).toBeInstanceOf(ToolLoopAgent);
    if (false) {
      // @ts-expect-error USER hooks require messages from onStart.
      onStart(assistantInput());
      // @ts-expect-error ASSISTANT hooks require finalStep from onEnd.
      onEnd(userInput());
      // @ts-expect-error ASSISTANT hooks cannot be registered onStart.
      new ToolLoopAgent({ model, onStart: onEnd });
      // @ts-expect-error USER hooks cannot be registered onEnd.
      new ToolLoopAgent({ model, onEnd: onStart });
    }
  });

  it('requires fixed scope, a valid role and actor, matching USER identity, and valid callbacks', () => {
    const http = transport();
    for (const missing of [{}, { userId: 'user-1' }, { sessionId: 'session-1' }]) {
      const memory = createRedisAgentMemoryTools(serverURL, 'store-1', apiKey, missing);
      expect(() => memory.createSessionEventHook({ role: 'USER', actorId: 'user-1', onError: vi.fn() })).toThrow();
    }
    for (const options of [
      { role: 'USER', actorId: 'another-user', onError: vi.fn() },
      { role: 'ASSISTANT', actorId: '', onError: vi.fn() },
      { role: 'ASSISTANT', actorId: 'x'.repeat(256), onError: vi.fn() },
      { role: 'SYSTEM', actorId: 'assistant-1', onError: vi.fn() },
      { role: 'ASSISTANT', actorId: 'assistant-1' },
      { role: 'ASSISTANT', actorId: 'assistant-1', onError: 'not a callback' },
      { role: 'ASSISTANT', actorId: 'assistant-1', onError: vi.fn(), onEventStart: true },
      { role: 'ASSISTANT', actorId: 'assistant-1', onError: vi.fn(), onEventSaved: true },
    ]) {
      expect(() => tools().createSessionEventHook(options as unknown as SessionEventHookOptions)).toThrow();
    }
    expect(http.fetch).not.toHaveBeenCalled();
  });

  it('saves just the latest USER, preserving separate text parts and ignoring attachments', async () => {
    const http = transport();
    const events: SessionHookEvent[] = [];
    const onError = vi.fn();
    const hook = tools().createSessionEventHook({
      role: 'USER', actorId: 'user-1', onError,
      onEventStart: event => { events.push(event); },
      onEventSaved: event => { events.push(event); },
    });

    await hook(userInput([
      { role: 'user', content: 'An old question.' },
      { role: 'assistant', content: 'An old answer.' },
      { role: 'user', content: [
        { type: 'text', text: 'First part.' },
        { type: 'image', image: new URL('https://image.example.test/picture.png') },
        { type: 'text', text: '' },
        { type: 'text', text: 'Second part.' },
      ] },
    ]));

    expect(onError).not.toHaveBeenCalled();
    expect(http.writes).toMatchObject([
      { sessionId: 'session-1', actorId: 'user-1', role: 'USER', content: [{ text: 'First part.' }, { text: 'Second part.' }] },
    ]);
    expect(http.writes).toHaveLength(1);
    expect(events).toEqual([
      { sessionId: 'session-1', role: 'USER', actorId: 'user-1' },
      { sessionId: 'session-1', role: 'USER', actorId: 'user-1' },
    ]);
  });

  it('saves only the final ASSISTANT text without requiring input messages or request data', async () => {
    const http = transport({ owners: [['session-1', 'user-1']] });
    const onError = vi.fn();
    const hook = tools().createSessionEventHook({ role: 'ASSISTANT', actorId: 'assistant-1', onError });

    await hook(assistantInput('The final answer.'));

    expect(onError).not.toHaveBeenCalled();
    expect(http.writes).toHaveLength(1);
    expect(http.writes[0]).toMatchObject({
      sessionId: 'session-1', actorId: 'assistant-1', role: 'ASSISTANT', content: [{ text: 'The final answer.' }],
    });
  });

  it.each([
    { name: 'missing USER messages', role: 'USER', input: {} },
    { name: 'empty USER messages', role: 'USER', input: userInput([]) },
    { name: 'trailing assistant', role: 'USER', input: userInput([{ role: 'user', content: 'Old question.' }, { role: 'assistant', content: 'Old answer.' }]) },
    { name: 'attachments only', role: 'USER', input: userInput([{ role: 'user', content: [{ type: 'image', image: new URL('https://image.example.test/only.png') }] }]) },
    { name: 'empty user', role: 'USER', input: userInput([{ role: 'user', content: '' }]) },
    { name: 'oversized user', role: 'USER', input: userInput([{ role: 'user', content: 'x'.repeat(50_001) }]) },
    { name: 'missing ASSISTANT finalStep', role: 'ASSISTANT', input: {} },
    { name: 'non-string assistant', role: 'ASSISTANT', input: { finalStep: { text: 42 } } },
    { name: 'oversized assistant', role: 'ASSISTANT', input: assistantInput('x'.repeat(50_001)) },
  ] as const)('reports validation failure before writing for $name', async ({ role, input }) => {
    const http = transport();
    const actorId = role === 'USER' ? 'user-1' : 'assistant-1';
    const onError = vi.fn<(error: RedisAgentMemoryToolError, context: SessionEventHookErrorContext) => void>();
    const onEventStart = vi.fn();
    const hook = tools().createSessionEventHook({ role, actorId, onError, onEventStart });

    await expect(hook(input as SessionEventHookInput)).resolves.toBeUndefined();

    expect(http.fetch).not.toHaveBeenCalled();
    expect(onEventStart).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(RedisAgentMemoryToolError);
    expect(onError.mock.calls[0]![1]).toEqual({ ...scope, phase: 'validation', role, actorId });
  });

  it('skips an empty final assistant response without writes or observers', async () => {
    const http = transport();
    const onError = vi.fn();
    const onEventStart = vi.fn();
    const onEventSaved = vi.fn();
    const hook = tools().createSessionEventHook({ role: 'ASSISTANT', actorId: 'assistant-1', onError, onEventStart, onEventSaved });

    await hook(assistantInput(''));

    expect(http.fetch).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onEventStart).not.toHaveBeenCalled();
    expect(onEventSaved).not.toHaveBeenCalled();
  });

  it.each(['USER', 'ASSISTANT'] as const)('reports a sanitized failed %s write without retries', async role => {
    const http = transport({ failRole: role, owners: [['session-1', 'user-1']] });
    const actorId = role === 'USER' ? 'user-1' : 'assistant-1';
    const onError = vi.fn<(error: RedisAgentMemoryToolError, context: SessionEventHookErrorContext) => void>();
    const onEventSaved = vi.fn();
    const hook = tools().createSessionEventHook({ role, actorId, onError, onEventSaved });

    await expect(hook(role === 'USER' ? userInput() : assistantInput())).resolves.toBeUndefined();

    expect(http.writes.map(event => event.role)).toEqual([role]);
    expect(onEventSaved).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, context] = onError.mock.calls[0]!;
    expect(error).toBeInstanceOf(RedisAgentMemoryToolError);
    expect(error).toMatchObject({ code: 'IRIS_HTTP_403', statusCode: 403 });
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(apiKey);
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('private conversation content');
    expect(context).toEqual({ ...scope, phase: 'write', role, actorId });
  });

  it('keeps independently created hooks usable after another hook fails', async () => {
    const http = transport({ failRole: 'USER', owners: [['session-1', 'user-1']] });
    const memory = tools();
    const onError = vi.fn();
    const user = memory.createSessionEventHook({ role: 'USER', actorId: 'user-1', onError });
    const assistant = memory.createSessionEventHook({ role: 'ASSISTANT', actorId: 'assistant-1', onError });

    await user(userInput());
    await assistant(assistantInput());

    expect(http.writes.map(event => event.role)).toEqual(['USER', 'ASSISTANT']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toMatchObject({ role: 'USER', phase: 'write' });
  });

  it('uses scoped ownership checks before appending to an existing session', async () => {
    const http = transport({ owners: [['session-1', 'another-user']] });
    const onError = vi.fn();

    await tools().createSessionEventHook({ role: 'USER', actorId: 'user-1', onError })(userInput());

    expect(http.writes).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_SCOPE' }), {
      ...scope, phase: 'write', role: 'USER', actorId: 'user-1',
    });
  });

  it('captures role, actor, and callbacks instead of reading mutable options during execution', async () => {
    const http = transport();
    const originalSaved = vi.fn();
    const originalError = vi.fn();
    const replacementSaved = vi.fn();
    const replacementError = vi.fn();
    const options: SessionEventHookOptions = { role: 'USER', actorId: 'user-1', onError: originalError, onEventSaved: originalSaved };
    const hook: SessionEventHook = tools().createSessionEventHook(options);
    options.role = 'ASSISTANT';
    options.actorId = 'changed-actor';
    options.onEventSaved = replacementSaved;
    options.onError = replacementError;

    await hook(userInput());
    await hook(userInput([]));

    expect(http.writes).toHaveLength(1);
    expect(http.writes[0]).toMatchObject({ role: 'USER', actorId: 'user-1' });
    expect(originalSaved).toHaveBeenCalledOnce();
    expect(originalError).toHaveBeenCalledOnce();
    expect(replacementSaved).not.toHaveBeenCalled();
    expect(replacementError).not.toHaveBeenCalled();
  });

  it('ignores throwing observers without disrupting the write or escaping the hook', async () => {
    const http = transport();
    const onError = vi.fn();
    const hook = tools().createSessionEventHook({
      role: 'USER', actorId: 'user-1', onError,
      onEventStart: () => { throw new Error('UI observer failed'); },
      onEventSaved: async () => { throw new Error('Async UI observer failed'); },
    });

    await expect(hook(userInput())).resolves.toBeUndefined();

    expect(http.writes.map(event => event.role)).toEqual(['USER']);
    expect(onError).not.toHaveBeenCalled();
    const failed = transport({ failRole: 'USER' });
    await expect(tools().createSessionEventHook({
      role: 'USER', actorId: 'user-1', onError: async () => { throw new Error('Error observer failed'); },
    })(userInput())).resolves.toBeUndefined();
    expect(failed.writes).toHaveLength(1);
  });

  it('awaits start and saved observers before writing and completing', async () => {
    const http = transport();
    let startObserved!: () => void;
    const started = new Promise<void>(resolve => { startObserved = resolve; });
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    let savedObserved!: () => void;
    const saved = new Promise<void>(resolve => { savedObserved = resolve; });
    let releaseSaved!: () => void;
    const savedGate = new Promise<void>(resolve => { releaseSaved = resolve; });
    const hook = tools().createSessionEventHook({
      role: 'USER', actorId: 'user-1', onError: vi.fn(),
      onEventStart: async () => { startObserved(); await startGate; },
      onEventSaved: async () => { savedObserved(); await savedGate; },
    });
    let complete = false;
    const recording = hook(userInput()).then(() => { complete = true; });
    try {
      await started;
      expect(http.fetch).not.toHaveBeenCalled();
      releaseStart();
      await saved;
      await Promise.resolve();
      expect(http.writes).toHaveLength(1);
      expect(complete).toBe(false);
    } finally {
      releaseStart();
      releaseSaved();
    }
    await recording;
    expect(complete).toBe(true);
  });

  it('isolates concurrent hooks derived from the same reusable toolset', async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let releaseFirst!: () => void;
    const released = new Promise<void>(resolve => { releaseFirst = resolve; });
    const http = transport({ beforeWrite: async event => {
      if (event.sessionId === 'session-1') { notifyStarted(); await released; }
    } });
    const memory = createRedisAgentMemoryTools(serverURL, 'store-1', apiKey);
    const onError = vi.fn();
    const first = memory.withContext(scope).createSessionEventHook({ role: 'USER', actorId: 'user-1', onError });
    const second = memory.withContext({ userId: 'user-2', sessionId: 'session-2' })
      .createSessionEventHook({ role: 'USER', actorId: 'user-2', onError });
    const firstRun = first(userInput([{ role: 'user', content: 'First question.' }]));
    await started;
    try {
      await second(userInput([{ role: 'user', content: 'Second question.' }]));
    } finally {
      releaseFirst();
    }
    await firstRun;

    expect(onError).not.toHaveBeenCalled();
    expect(http.writes).toHaveLength(2);
    expect(http.writes).toMatchObject([
      { sessionId: 'session-1', actorId: 'user-1', role: 'USER', content: [{ text: 'First question.' }] },
      { sessionId: 'session-2', actorId: 'user-2', role: 'USER', content: [{ text: 'Second question.' }] },
    ]);
  });

  it.each(['generate', 'stream'] as const)('records USER before model execution and ASSISTANT onEnd during %s', async mode => {
    const order: string[] = [];
    const http = transport({ beforeWrite: event => { order.push(event.role); } });
    const memory = tools();
    const onError = vi.fn();
    const onStart: SessionEventHook<'USER'> = memory.createSessionEventHook({ role: 'USER', actorId: 'user-1', onError });
    const onEnd: SessionEventHook<'ASSISTANT'> = memory.createSessionEventHook({ role: 'ASSISTANT', actorId: 'assistant-1', onError });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        order.push('MODEL');
        return {
          content: [{ type: 'text', text: 'The response.' }],
          finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
        };
      },
      doStream: async () => {
        order.push('MODEL');
        return { stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'The response.' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ]) };
      },
    });
    const agent = new ToolLoopAgent({ model, tools: memory, onStart, onEnd });

    if (mode === 'generate') {
      expect((await agent.generate({ prompt: 'The question.' })).finalStep.text).toBe('The response.');
    } else {
      const response = await agent.stream({ prompt: 'The question.' });
      for await (const _part of response.stream) { /* Consume the stream to trigger onEnd. */ }
      expect((await response.finalStep).text).toBe('The response.');
    }

    expect(onError).not.toHaveBeenCalled();
    expect(order).toEqual(['USER', 'MODEL', 'ASSISTANT']);
    expect(http.writes).toMatchObject([
      { actorId: 'user-1', role: 'USER', content: [{ text: 'The question.' }] },
      { actorId: 'assistant-1', role: 'ASSISTANT', content: [{ text: 'The response.' }] },
    ]);
    const modelTools = mode === 'generate' ? model.doGenerateCalls[0]!.tools : model.doStreamCalls[0]!.tools;
    expect(modelTools?.map(tool => tool.name)).not.toContain('createSessionEventHook');
  });

  it('retains the USER event when model generation fails before onEnd', async () => {
    const http = transport();
    const memory = tools();
    const onError = vi.fn();
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('Model unavailable'); } });
    const agent = new ToolLoopAgent({
      model, tools: memory, maxRetries: 0,
      onStart: memory.createSessionEventHook({ role: 'USER', actorId: 'user-1', onError }),
      onEnd: memory.createSessionEventHook({ role: 'ASSISTANT', actorId: 'assistant-1', onError }),
    });

    await expect(agent.generate({ prompt: 'Keep this question.' })).rejects.toThrow('Model unavailable');

    expect(onError).not.toHaveBeenCalled();
    expect(http.writes).toHaveLength(1);
    expect(http.writes[0]).toMatchObject({ role: 'USER', content: [{ text: 'Keep this question.' }] });
  });
});
