import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { stepCountIs, streamText, tool } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import { createRedisAgentMemoryProvider, type RedisAgentMemoryDiagnostic } from '../src/provider.js';

const serverUrl = 'https://stream.example.test';
const timestamp = '2026-10-07T12:00:00.000Z';
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const params: LanguageModelV4CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Question.' }] }],
};
type JsonRecord = Record<string, unknown>;

afterEach(() => vi.unstubAllGlobals());

function setupTransport(options: { holdAssistant?: boolean; failAssistant?: boolean } = {}) {
  const requests: Array<{ request: Request; body?: JsonRecord }> = [];
  let releaseAssistant!: () => void;
  const assistantGate = new Promise<void>(resolve => { releaseAssistant = resolve; });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    const body = text ? JSON.parse(text) as JsonRecord : undefined;
    requests.push({ request, body });
    if (request.url.endsWith('/long-term-memory/search')) return Response.json({ items: [{
      id: 'memory-1', text: 'Remembered.', ownerId: 'user-1', createdAt: timestamp, updatedAt: timestamp,
    }] });
    if (request.method === 'GET') return Response.json({ sessionId: 'session-1', ownerId: 'user-1', events: [] });
    if (body?.role === 'ASSISTANT' && options.holdAssistant) await assistantGate;
    if (body?.role === 'ASSISTANT' && options.failAssistant) return Response.json({ title: 'Failed' }, { status: 500 });
    return Response.json({ event: {
      ...body, eventId: `event-${requests.length}`, createdAt: timestamp, systemTimestamp: timestamp,
    } }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, releaseAssistant };
}

function forRequest(model: MockLanguageModelV4, options: Record<string, unknown> = {}) {
  return createRedisAgentMemoryProvider({ serverUrl, storeId: 'store-1', apiKey: 'secret-key', model }).forRequest({
    scope: { userId: 'user-1', sessionId: 'session-1' }, assistantId: 'assistant-1', ...options,
  });
}

async function readAll(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  return parts;
}

describe('Redis Agent Memory provider streaming', () => {
  it('passes nonterminal parts immediately and holds finish until source close plus assistant write', async () => {
    const http = setupTransport({ holdAssistant: true });
    const start = { type: 'stream-start' as const, warnings: [] };
    const delta = { type: 'text-delta' as const, id: 'answer', delta: 'Stream answer.' };
    const finish = { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage };
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([start, delta, finish]),
      request: { body: { retained: true } }, response: { headers: { 'x-base': 'yes' } },
    }) });

    const result = await forRequest(model).doStream(params);
    expect(result.request).toEqual({ body: { retained: true } });
    expect(result.response).toEqual({ headers: { 'x-base': 'yes' } });
    const reader = result.stream.getReader();
    expect((await reader.read()).value).toBe(start);
    expect((await reader.read()).value).toBe(delta);
    const pendingFinish = reader.read();
    await vi.waitFor(() => expect(http.requests.some(({ body }) => body?.role === 'ASSISTANT')).toBe(true));
    let settled = false;
    void pendingFinish.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    http.releaseAssistant();
    expect((await pendingFinish).value).toBe(finish);
    expect((await reader.read()).done).toBe(true);
  });

  it('records after raw source completion even when downstream never consumes the wrapped stream', async () => {
    const http = setupTransport();
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'text-delta', id: 'answer', delta: 'Completed raw output.' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ]),
    }) });

    await forRequest(model).doStream(params);

    await vi.waitFor(() => expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(1));
  });

  it('suppresses assistant recording and the held finish when upstream errors after finish', async () => {
    const http = setupTransport();
    const failure = new Error('raw stream failed');
    const start = { type: 'stream-start' as const, warnings: [] };
    const finish = { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage };
    let releaseError!: () => void;
    const errorGate = new Promise<void>(resolve => { releaseError = resolve; });
    let pull = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({
      async pull(controller) {
        pull += 1;
        if (pull === 1) controller.enqueue(start);
        else if (pull === 2) controller.enqueue(finish);
        else {
          await errorGate;
          controller.error(failure);
        }
      },
    }) }) });

    const reader = (await forRequest(model).doStream(params)).stream.getReader();
    expect((await reader.read()).value).toBe(start);
    releaseError();
    await expect(reader.read()).rejects.toBe(failure);
    expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(0);
  });

  it('passes through a raw error part before finish but suppresses finish and assistant recording', async () => {
    const http = setupTransport();
    const rawError = new Error('provider stream error');
    const errorPart = { type: 'error' as const, error: rawError };
    const finish = { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage };
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'text-delta', id: 'answer', delta: 'Partial.' }, errorPart, finish,
      ]),
    }) });

    const parts = await readAll((await forRequest(model).doStream(params)).stream);
    expect(parts).toEqual([{ type: 'text-delta', id: 'answer', delta: 'Partial.' }, errorPart]);
    expect(parts[1]).toBe(errorPart);
    expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(0);
  });

  it('closes without a synthetic finish or assistant write when upstream closes without finish', async () => {
    const http = setupTransport();
    const start = { type: 'stream-start' as const, warnings: [] };
    const result = await forRequest(new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([start]),
    }) })).doStream(params);

    expect(await readAll(result.stream)).toEqual([start]);
    expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(0);
  });

  it('cancels the raw source before commit and releases the wrapper for a later call', async () => {
    const http = setupTransport();
    let sourceCancelled = false;
    let calls = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: ++calls === 1
      ? new ReadableStream({
        start(controller) { controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'partial' }); },
        cancel() { sourceCancelled = true; },
      })
      : convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }])
    }) });
    const wrapped = forRequest(model);
    const first = await wrapped.doStream(params);
    const reader = first.stream.getReader();
    expect((await reader.read()).value).toMatchObject({ type: 'text-delta' });
    await reader.cancel('stop');
    await vi.waitFor(() => expect(sourceCancelled).toBe(true));

    await expect(wrapped.doStream(params)).resolves.toBeDefined();
    expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(0);
  });

  it('cancels a pending finish while an ASSISTANT POST is in flight without retrying it', async () => {
    const http = setupTransport({ holdAssistant: true });
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'text-delta', id: 'answer', delta: 'Answer.' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ]),
    }) });
    const reader = (await forRequest(model).doStream(params)).stream.getReader();
    expect((await reader.read()).value).toMatchObject({ type: 'text-delta' });
    const pendingFinish = reader.read();
    await vi.waitFor(() => expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(1));

    await reader.cancel('disconnect');
    await expect(pendingFinish).resolves.toMatchObject({ done: true });
    http.releaseAssistant();
    await Promise.resolve();
    expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(1);
  });

  it('preserves raw completion when caller aborts during the held ASSISTANT write', async () => {
    const http = setupTransport({ holdAssistant: true });
    const diagnostics: RedisAgentMemoryDiagnostic[] = [];
    const controller = new AbortController();
    const finish = { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage };
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'text-delta', id: 'answer', delta: 'Completed answer.' }, finish,
      ]),
    }) });
    const reader = (await forRequest(model, {
      onDiagnostic: (event: RedisAgentMemoryDiagnostic) => diagnostics.push(event),
    }).doStream({ ...params, abortSignal: controller.signal })).stream.getReader();
    expect((await reader.read()).value).toMatchObject({ type: 'text-delta' });
    const pendingFinish = reader.read();
    await vi.waitFor(() => expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(1));

    controller.abort(new DOMException('Caller stopped waiting.', 'AbortError'));

    expect((await pendingFinish).value).toBe(finish);
    expect((await reader.read()).done).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: 'session.assistant.write', outcome: 'failure', writeStatus: 'unknown',
    }));
    http.releaseAssistant();
  });

  it('passes an overflowing text stream unchanged while buffering only enough to skip the whole event', async () => {
    const http = setupTransport();
    const diagnostics: RedisAgentMemoryDiagnostic[] = [];
    const deltas = ['1234', '5678', '90'].map((delta, index) => ({
      type: 'text-delta' as const, id: 'answer', delta, providerMetadata: { base: { index } },
    }));
    const finish = { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage };
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([...deltas, finish]),
    }) });

    const result = await forRequest(model, {
      limits: { recordingChars: 10 }, onDiagnostic: (event: RedisAgentMemoryDiagnostic) => diagnostics.push(event),
    }).doStream({ ...params, prompt: [{ role: 'user', content: [{ type: 'text', text: 'Q' }] }] });

    expect(await readAll(result.stream)).toEqual([...deltas, finish]);
    expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(0);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: 'session.assistant.write', outcome: 'too_large', writeStatus: 'not_started',
    }));
  });

  it('preserves finish on assistant failure and merges provenance only without collision', async () => {
    setupTransport({ failAssistant: true });
    const baseMetadata = { base: { retained: true } };
    const finish = {
      type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage,
      providerMetadata: baseMetadata,
    };
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([{ type: 'text-delta', id: 'answer', delta: 'Answer.' }, finish]),
    }) });

    const parts = await readAll((await forRequest(model, { includeMemoryProvenance: true }).doStream(params)).stream);
    expect(parts.at(-1)).toEqual({
      ...finish,
      providerMetadata: {
        ...baseMetadata,
        redisAgentMemory: { memories: [{ id: 'memory-1', createdAt: timestamp, updatedAt: timestamp }] },
      },
    });
  });

  it('preserves finishes and latches recording off after an ASSISTANT scope invariant', async () => {
    let sessionGets = 0;
    const posts: JsonRecord[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith('/long-term-memory/search')) return Response.json({ items: [] });
      if (request.method === 'GET') {
        sessionGets += 1;
        return Response.json({
          sessionId: 'session-1', ownerId: sessionGets >= 3 ? 'another-user' : 'user-1', events: [],
        });
      }
      const body = await request.json() as JsonRecord;
      posts.push(body);
      return Response.json({ event: {
        ...body, eventId: `event-${posts.length}`, createdAt: timestamp, systemTimestamp: timestamp,
      } }, { status: 201 });
    }));
    let calls = 0;
    const finishes = [1, 2].map(index => ({
      type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: `stop-${index}` }, usage,
    }));
    const model = new MockLanguageModelV4({ doStream: async () => {
      const index = calls++;
      return { stream: convertArrayToReadableStream([
        { type: 'text-delta', id: 'answer', delta: `Answer ${index + 1}.` }, finishes[index]!,
      ]) };
    } });
    const wrapped = forRequest(model);

    const first = await readAll((await wrapped.doStream(params)).stream);
    const second = await readAll((await wrapped.doStream(params)).stream);

    expect(first.at(-1)).toBe(finishes[0]);
    expect(second.at(-1)).toBe(finishes[1]);
    expect(posts.map(post => post.role)).toEqual(['USER']);
    expect(sessionGets).toBe(3);
  });

  it('preserves a colliding finish metadata object unchanged and diagnoses the collision', async () => {
    setupTransport();
    const diagnostics: RedisAgentMemoryDiagnostic[] = [];
    const providerMetadata = {
      base: { retained: true }, redisAgentMemory: null,
    } as unknown as SharedV4ProviderMetadata;
    const finish = {
      type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, providerMetadata,
    };
    const model = new MockLanguageModelV4({ doStream: async () => ({
      stream: convertArrayToReadableStream([finish]),
    }) });

    const parts = await readAll((await forRequest(model, {
      recording: false, includeMemoryProvenance: true,
      onDiagnostic: (event: RedisAgentMemoryDiagnostic) => diagnostics.push(event),
    }).doStream(params)).stream);

    expect(parts[0]).toBe(finish);
    expect((parts[0] as typeof finish).providerMetadata).toBe(providerMetadata);
    expect(diagnostics).toContainEqual(expect.objectContaining({ operation: 'provenance.merge', outcome: 'collision' }));
  });

  it('reinjects one cached snapshot through an actual AI SDK streaming tool loop', async () => {
    const http = setupTransport();
    let calls = 0;
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doStream: async options => {
      prompts.push(JSON.stringify(options.prompt));
      calls += 1;
      const parts: LanguageModelV4StreamPart[] = calls === 1 ? [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'lookup-1', toolName: 'lookup', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
      ] : [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: 'Final answer.' },
        { type: 'text-end', id: 'answer' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ];
      return { stream: convertArrayToReadableStream(parts) };
    } });
    const memoryModel = forRequest(model);

    const result = streamText({
      model: memoryModel,
      prompt: 'Question.',
      tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => ({ found: true }) }) },
      stopWhen: stepCountIs(2),
    });

    expect(await result.text).toBe('Final answer.');
    expect(prompts).toHaveLength(2);
    expect(prompts.every(prompt => prompt.split('Remembered.').length === 2)).toBe(true);
    expect(http.requests.filter(({ request }) => request.url.endsWith('/long-term-memory/search'))).toHaveLength(1);
    expect(http.requests.filter(({ body }) => body?.role === 'USER')).toHaveLength(1);
    expect(http.requests.filter(({ body }) => body?.role === 'ASSISTANT')).toHaveLength(1);
  });
});
