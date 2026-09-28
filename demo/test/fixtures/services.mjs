import { appendFileSync } from 'node:fs';

// Loaded only into demo subprocesses. There is no fallback to real network calls.
let modelCalls = 0;
const memories = [];
const sessions = new Map();
let failedAppend = false;
const record = entry => appendFileSync(process.env.DEMO_TEST_TRACE, `${JSON.stringify(entry)}\n`);
const reply = (content, stopReason = 'end_turn') => Response.json({
  id: `message-${modelCalls}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 20, output_tokens: 10 },
});

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = request.body ? await request.json() : undefined;
  const entry = { url: request.url, method: request.method, body };

  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
    record({ kind: 'model', ...entry });
    modelCalls += 1;
    if (modelCalls === 1) {
      return reply([{ type: 'text', text: 'I will save that preference.' }, {
        type: 'tool_use', id: 'save-1', name: 'create_memories',
        input: { memories: [{ text: 'The user prefers TypeScript examples.' }] },
      }], 'tool_use');
    }
    if (modelCalls === 2) {
      if (process.env.DEMO_TEST_SCENARIO === 'failed-reply') {
        return Response.json({
          type: 'error', error: { type: 'api_error', message: 'Injected failure after the memory write.' },
        }, { status: 500 });
      }
      if (process.env.DEMO_TEST_SCENARIO === 'empty-reply') return reply([]);
      return reply([{ type: 'text', text: 'Saved your preference.' }]);
    }
    if (modelCalls === 3) {
      return reply([{ type: 'text', text: 'I will check your saved preferences.' }, {
        type: 'tool_use', id: 'recall-1', name: 'search_memories',
        input: { text: 'preferred programming language for examples' },
      }], 'tool_use');
    }
    if (modelCalls === 4) {
      return reply([{ type: 'text', text: 'You prefer TypeScript examples.' }]);
    }
  }

  const memoryPath = '/v1/stores/demo-test-store/long-term-memory';
  const sessionPath = '/v1/stores/demo-test-store/session-memory';
  if (url.origin === 'https://memory.example.test') {
    if (request.method === 'GET' && url.pathname.startsWith(`${sessionPath}/`)) {
      record({ kind: 'session-get', ...entry });
      const sessionId = url.pathname.slice(sessionPath.length + 1);
      const events = sessions.get(sessionId);
      return events
        ? Response.json({ sessionId, ownerId: events[0].actorId, events })
        : Response.json({ title: 'Session not found', type: '/errors/resource-not-found' }, { status: 404 });
    }
    if (request.method === 'POST' && url.pathname === `${sessionPath}/events`) {
      record({ kind: 'session-append', ...entry });
      if (process.env.DEMO_TEST_SCENARIO === 'slow-session-events') {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const events = sessions.get(body.sessionId) ?? [];
      const event = {
        ...body, eventId: `event-${events.length + 1}`,
        systemTimestamp: '2026-09-28T12:00:00.000Z',
      };
      events.push(event);
      sessions.set(body.sessionId, events);
      const failedRole = {
        'failed-user-event': 'USER',
        'failed-assistant-event': 'ASSISTANT',
      }[process.env.DEMO_TEST_SCENARIO];
      if (!failedAppend && failedRole === body.role) {
        // Simulate an uncertain write: Redis saved it but the response failed.
        failedAppend = true;
        return Response.json({ title: 'Injected append failure', type: '/errors/unexpected-error' }, { status: 500 });
      }
      if (process.env.DEMO_TEST_SCENARIO === 'slow-session-events') {
        record({ kind: 'session-append-complete', role: body.role, sessionId: body.sessionId });
      }
      return Response.json({ event }, { status: 201 });
    }
  }
  if (url.origin === 'https://memory.example.test' && request.method === 'POST') {
    if (url.pathname === memoryPath) {
      record({ kind: 'create', ...entry });
      memories.push(...body.memories);
      return Response.json({ created: body.memories.map(memory => memory.id) }, { status: 201 });
    }
    if (url.pathname === `${memoryPath}/search`) {
      record({ kind: 'search', ...entry });
      return Response.json({ items: memories.map(memory => ({
        ...memory,
        createdAt: '2026-09-28T12:00:00.000Z',
        updatedAt: '2026-09-28T12:00:00.000Z',
      })) });
    }
  }

  record({ kind: 'unexpected', ...entry });
  throw new Error(`Unexpected test request: ${request.method} ${request.url}`);
};
