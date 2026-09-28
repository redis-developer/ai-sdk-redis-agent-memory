import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStepCount, ToolLoopAgent } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { RedisAgentMemory, irisMemoryInstructions } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const recall = {
  type: 'tool-call' as const,
  toolCallId: 'recall-1',
  toolName: 'search_memories',
  input: '{"text":"communication preferences"}',
};

function memoryTools(fetch: typeof globalThis.fetch) {
  vi.stubGlobal('fetch', fetch);
  return new RedisAgentMemory(
    'https://memory.example.test',
    'store-1',
    'fake-agent-execution-test-key',
    { userId: 'user-1', sessionId: 'current-session' },
  );
}

describe('AI SDK 7 agent execution', () => {
  it('streams a memory tool result into the next model step with enforced owner scope', async () => {
    const requests: Array<{ request: Request; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({ request, body: await request.clone().json() });
      return Response.json({
        items: [{
          id: 'memory-1',
          text: 'Prefers concise replies.',
          ownerId: 'user-1',
          sessionId: 'previous-session',
          createdAt: '2026-09-25T12:34:56.000Z',
          updatedAt: '2026-09-25T12:34:56.000Z',
        }],
      });
    };
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async options => {
        modelCalls += 1;
        if (modelCalls === 1) {
          expect(options.tools?.some(tool => tool.name === 'search_memories')).toBe(true);
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              recall,
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
            ]),
          };
        }
        expect(JSON.stringify(options.prompt)).toContain('Prefers concise replies.');
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'reply' },
            { type: 'text-delta', id: 'reply', delta: 'I will keep my replies concise.' },
            { type: 'text-end', id: 'reply' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ]),
        };
      },
    });
    const agent = new ToolLoopAgent({
      model,
      tools: memoryTools(fetch),
      instructions: irisMemoryInstructions,
      stopWhen: isStepCount(3),
    });

    const result = await agent.stream({ prompt: 'How do I prefer you to respond?' });
    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(parts.some(part => part.type === 'error' || part.type === 'tool-error')).toBe(false);
    expect(parts.find(part => part.type === 'tool-result')).toMatchObject({
      type: 'tool-result',
      toolCallId: 'recall-1',
      toolName: 'search_memories',
      output: { items: [{ id: 'memory-1', text: 'Prefers concise replies.', sessionId: 'previous-session' }] },
    });
    expect(parts.find(part => part.type === 'text-delta')).toMatchObject({
      text: 'I will keep my replies concise.',
    });
    expect((await result.finalStep).text).toBe('I will keep my replies concise.');
    expect(await result.steps).toHaveLength(2);
    expect(modelCalls).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.request.method).toBe('POST');
    expect(requests[0]!.request.url).toBe('https://memory.example.test/v1/stores/store-1/long-term-memory/search');
    expect(requests[0]!.body).toMatchObject({
      text: 'communication preferences',
      filter: { ownerId: { eq: 'user-1' } },
      filterOp: 'all',
    });
    expect(requests[0]!.body).toHaveProperty('filter', { ownerId: { eq: 'user-1' } });
  });

  it('cancels in-flight Redis HTTP work when an agent generation is aborted', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      receivedSignal = request.signal;
      resolveStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    });
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [recall],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      },
    });
    const agent = new ToolLoopAgent({
      model,
      tools: memoryTools(fetch),
      instructions: irisMemoryInstructions,
      stopWhen: isStepCount(3),
    });

    const generation = agent.generate({ prompt: 'Recall my preferences.', abortSignal: controller.signal });
    const rejected = expect(generation).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;

    expect(receivedSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
