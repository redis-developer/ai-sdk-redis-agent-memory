import { appendFileSync } from 'node:fs';

const sessions = new Map();
let modelCalls = 0;
let failedWrite = false;
const record = entry => appendFileSync(process.env.DEMO_TEST_TRACE, `${JSON.stringify(entry)}\n`);

if (process.env.DEMO_SESSION_ID) {
  sessions.set(process.env.DEMO_SESSION_ID, [{
    sessionId: process.env.DEMO_SESSION_ID,
    eventId: 'seed-user', actorId: 'demo-test-user', role: 'USER',
    content: [{ text: 'Earlier session question.' }], createdAt: '2026-10-07T11:59:00.000Z',
    systemTimestamp: '2026-10-07T11:59:00.000Z',
  }, {
    sessionId: process.env.DEMO_SESSION_ID,
    eventId: 'seed-assistant', actorId: 'demo-assistant', role: 'ASSISTANT',
    content: [{ text: 'Earlier session answer.' }], createdAt: '2026-10-07T12:00:00.000Z',
    systemTimestamp: '2026-10-07T12:00:00.000Z',
  }]);
}

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = request.body ? await request.json() : undefined;
  const entry = { url: request.url, method: request.method, body };

  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
    record({ kind: 'model', ...entry });
    modelCalls += 1;
    if (process.env.DEMO_TEST_SCENARIO === 'model-failure' ||
      (process.env.DEMO_TEST_SCENARIO === 'first-model-failure' && modelCalls === 1)) {
      return Response.json({ type: 'error', error: { message: 'private-response-body', type: 'api_error' } }, { status: 500 });
    }
    const text = modelCalls === 1 ? 'First answer.'
      : JSON.stringify(body).includes('What do I prefer?')
        ? 'You prefer concise TypeScript examples.' : 'Second answer.';
    return Response.json({
      id: `message-${modelCalls}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  }

  const root = '/v1/stores/demo-test-store';
  const sessionRoot = `${root}/session-memory`;
  if (url.origin === 'https://memory.example.test') {
    if (request.method === 'GET' && url.pathname.startsWith(`${sessionRoot}/`)) {
      const sessionId = url.pathname.slice(sessionRoot.length + 1);
      record({ kind: 'session-preflight', ...entry });
      if (process.env.DEMO_TEST_SCENARIO === 'read-failure') {
        return Response.json({ detail: 'private-response-body' }, { status: 500 });
      }
      const events = sessions.get(sessionId);
      if (process.env.DEMO_TEST_SCENARIO === 'foreign-owner') {
        return Response.json({ sessionId, ownerId: 'another-user', events: [] });
      }
      return events
        ? Response.json({ sessionId, ownerId: 'demo-test-user', events })
        : Response.json({ title: 'Missing' }, { status: 404 });
    }
    if (request.method === 'POST' && url.pathname === `${sessionRoot}/events`) {
      record({ kind: 'session-append', ...entry });
      const events = sessions.get(body.sessionId) ?? [];
      const event = { ...body, eventId: `event-${events.length + 1}`, systemTimestamp: '2026-10-07T12:00:00.000Z' };
      events.push(event);
      sessions.set(body.sessionId, events);
      if (process.env.DEMO_TEST_SCENARIO === 'write-failure' && !failedWrite) {
        failedWrite = true;
        return Response.json({ detail: 'private-response-body' }, { status: 500 });
      }
      return Response.json({ event }, { status: 201 });
    }
    if (request.method === 'POST' && url.pathname === `${root}/long-term-memory/search`) {
      record({ kind: 'memory-search', ...entry });
      if (process.env.DEMO_TEST_SCENARIO === 'read-failure') {
        return Response.json({ detail: 'private-response-body' }, { status: 500 });
      }
      return Response.json({ items: [{
        id: 'memory-1', text: 'Prefers concise TypeScript examples.', ownerId: 'demo-test-user',
        createdAt: '2026-10-07T12:00:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z',
      }] });
    }
  }

  record({ kind: 'unexpected', ...entry });
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
};
