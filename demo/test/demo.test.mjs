import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypoint = fileURLToPath(new URL('../index.mjs', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/services.mjs', import.meta.url));
const remember = 'Remember that I prefer TypeScript examples.';
const recall = 'Which programming language do I prefer for examples?';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runDemo(input, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'redis-memory-demo-test-'));
  const traceFile = join(directory, 'requests.jsonl');
  try {
    // Isolated cwd and environment prevent loading developer credentials or .env.
    const env = {
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: 'fake-anthropic-key',
      AGENT_MEMORY_API_KEY: 'fake-redis-key',
      AGENT_MEMORY_STORE_ID: 'demo-test-store',
      AGENT_MEMORY_URL: 'https://memory.example.test',
      DEMO_USER_ID: 'demo-test-user',
      DEMO_TEST_TRACE: traceFile,
      ...overrides,
    };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete env[name];
    }
    const result = spawnSync(process.execPath, ['--import', preload, entrypoint], {
      cwd: directory, env, input, encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    let requests = [];
    try {
      requests = readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.deepEqual(requests.filter(request => request.kind === 'unexpected'), []);
    return { ...result, requests };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertSavedAndRecalled(result, { freshHistory = true } = {}) {
  assert.equal(result.status, 0, result.stderr);
  const creates = result.requests.filter(request => request.kind === 'create');
  const searches = result.requests.filter(request => request.kind === 'search');
  const model = result.requests.filter(request => request.kind === 'model');
  assert.equal(creates.length, 1, 'The preference must be written exactly once.');
  assert.equal(searches.length, 1, 'The new conversation must retrieve the saved preference.');
  assert.equal(model.length, 4, 'Each turn uses one tool step and one reply step.');
  assert.ok(model.every(request => request.method === 'POST'));
  assert.equal(creates[0].body.memories[0].ownerId, 'demo-test-user');
  assert.match(creates[0].body.memories[0].id, uuid);
  assert.deepEqual(searches[0].body.filter, { ownerId: { eq: 'demo-test-user' } });
  assert.equal(searches[0].body.filterOp, 'all');
  assert.match(JSON.stringify(model[2].body.messages), /Which programming language/);
  if (freshHistory) {
    assert.equal(model[2].body.messages.length, 1, 'The recall turn must not contain old chat history.');
    assert.equal(model[2].body.messages[0].role, 'user');
    assert.doesNotMatch(JSON.stringify(model[2].body.messages), /Remember that|TypeScript|tool_use|tool_result/);
  } else {
    for (const text of [/Remember that/, /I will save that preference/, /Saved your preference/, /tool_use/, /tool_result/]) {
      assert.match(JSON.stringify(model[2].body.messages), text);
    }
  }
  assert.ok(model.every(request => !request.body.tools.some(tool => tool.name === 'add_session_event')),
    'Only the application records session events, so model tools cannot duplicate them.');
  assert.match(JSON.stringify(model[3].body.messages), /The user prefers TypeScript examples/);
  assert.match(result.stdout, /\[memory\] 1 saved; 0 failed\./);
  assert.match(result.stdout, /\[memory\] 1 found\./);
  assert.match(result.stdout, /Assistant: You prefer TypeScript examples\./);
}

function sessionEvents(result) {
  return result.requests.filter(request => request.kind === 'session-append').map(request => request.body);
}

function assertSessionEvents(result, roles, texts) {
  const events = sessionEvents(result);
  assert.deepEqual(events.map(event => event.role), roles);
  assert.deepEqual(events.map(event => event.content), texts.map(text => [{ text }]));
  for (const event of events) {
    assert.match(event.sessionId, uuid);
    assert.equal(event.actorId, event.role === 'USER' ? 'demo-test-user' : 'demo-assistant');
    assert.ok(Number.isFinite(Date.parse(event.createdAt)), 'Events include an actual timestamp.');
  }
  const preflights = result.requests.filter(request => request.kind === 'session-get');
  assert.ok(preflights.length >= events.length, 'Every append checks session ownership.');
  assert.ok(preflights.every(request => request.method === 'GET'
    && new URL(request.url).searchParams.get('includeSummarisedEvents') === 'false'));
  return events;
}

test('saving, /new, and recall use scoped Redis memory after clearing local history', () => {
  const result = runDemo(`${remember}\n/new\n${recall}\n/quit\n`);
  assertSavedAndRecalled(result);
  const events = assertSessionEvents(result, ['USER', 'ASSISTANT', 'USER', 'ASSISTANT'],
    [remember, 'Saved your preference.', recall, 'You prefer TypeScript examples.']);
  assert.equal(events[0].sessionId, events[1].sessionId);
  assert.equal(events[2].sessionId, events[3].sessionId);
  assert.notEqual(events[0].sessionId, events[2].sessionId, '/new must create a distinct session.');
  assert.equal(result.requests.find(request => request.kind === 'create').body.memories[0].sessionId,
    events[0].sessionId, 'A durable memory is associated with its originating session.');
  assert.deepEqual(result.requests.filter(request => request.kind !== 'session-get').map(request => request.kind),
    ['model', 'create', 'model', 'session-append', 'session-append',
      'model', 'search', 'model', 'session-append', 'session-append']);
  assert.ok(result.stdout.includes(`Session: ${events[0].sessionId}`));
  assert.ok(result.stdout.includes(`Session: ${events[2].sessionId}`));
  assert.match(result.stdout, /Assistant: Saved your preference\./);
  assert.match(result.stdout, /New conversation/);
  assert.match(result.stdout, /\[memory\] create_memories/);
  assert.match(result.stdout, /\[memory\] search_memories/);
  assert.match(result.stdout, /\[memory\] add_session_event/);
  assert.doesNotMatch(result.stdout, /\x1b\[/, 'Piped output is plain by default.');
  assert.equal(result.stderr, '');
});

test('follow-up turns retain local history and append to the same Redis session', () => {
  const result = runDemo(`${remember}\n${recall}\n/quit\n`);
  assertSavedAndRecalled(result, { freshHistory: false });
  const events = assertSessionEvents(result, ['USER', 'ASSISTANT', 'USER', 'ASSISTANT'],
    [remember, 'Saved your preference.', recall, 'You prefer TypeScript examples.']);
  assert.equal(new Set(events.map(event => event.sessionId)).size, 1);
  assert.equal(result.stderr, '');
});

test('completed turns await sequential session writes and persist only final assistant text', () => {
  const result = runDemo(`${remember}\n${recall}\n/quit\n`, { DEMO_TEST_SCENARIO: 'slow-session-events' });
  assertSavedAndRecalled(result, { freshHistory: false });
  assertSessionEvents(result, ['USER', 'ASSISTANT', 'USER', 'ASSISTANT'],
    [remember, 'Saved your preference.', recall, 'You prefer TypeScript examples.']);
  assert.deepEqual(result.requests.filter(request => request.kind !== 'session-get').map(request => request.kind),
    ['model', 'create', 'model', 'session-append', 'session-append-complete',
      'session-append', 'session-append-complete',
      'model', 'search', 'model', 'session-append', 'session-append-complete',
      'session-append', 'session-append-complete']);
  const savedReplies = [...result.stdout.matchAll(/ASSISTANT session event saved\./g)].map(match => match.index);
  const displayedReplies = [...result.stdout.matchAll(/Assistant:/g)].map(match => match.index);
  assert.equal(savedReplies.length, 2);
  assert.equal(displayedReplies.length, 2);
  assert.ok(savedReplies.every((offset, index) => offset < displayedReplies[index]),
    'The final session save is awaited before returning the generated reply to the CLI.');
  assert.equal(result.stderr, '');
});

test('failed generation records no session events and does not replay the failed turn', () => {
  const result = runDemo(`${remember}\n${recall}\n/quit\n`, { DEMO_TEST_SCENARIO: 'failed-reply' });
  assertSavedAndRecalled(result);
  const events = assertSessionEvents(result, ['USER', 'ASSISTANT'],
    [recall, 'You prefer TypeScript examples.']);
  assert.equal(new Set(events.map(event => event.sessionId)).size, 1);
  assert.match(result.stderr, /Request failed/);
  assert.match(result.stderr, /memory write may have succeeded/i);
  assert.doesNotMatch(result.stdout, /Assistant: Saved your preference\./);
});

test('an uncertain user append skips its assistant event and retains the reply without replay', () => {
  const result = runDemo(`${remember}\n${recall}\n/quit\n`, { DEMO_TEST_SCENARIO: 'failed-user-event', FORCE_COLOR: '1' });
  assertSavedAndRecalled(result, { freshHistory: false });
  const events = assertSessionEvents(result, ['USER', 'USER', 'ASSISTANT'],
    [remember, recall, 'You prefer TypeScript examples.']);
  assert.equal(new Set(events.map(event => event.sessionId)).size, 1);
  assert.match(result.stderr, /session|event/i);
  assert.match(result.stderr, /\x1b\[31m[^\n]*\[memory\]/, 'Failed memory calls appear in red.');
  assert.match(result.stdout, /Assistant: Saved your preference\./);
  assert.match(result.stderr, /not confirmed/i);
  assert.match(result.stderr, /may already be stored/i);
});

test('an uncertain assistant event append retains the reply and conversation without replaying it', () => {
  const result = runDemo(`${remember}\n${recall}\n/quit\n`, { DEMO_TEST_SCENARIO: 'failed-assistant-event' });
  assertSavedAndRecalled(result, { freshHistory: false });
  const events = assertSessionEvents(result, ['USER', 'ASSISTANT', 'USER', 'ASSISTANT'],
    [remember, 'Saved your preference.', recall, 'You prefer TypeScript examples.']);
  assert.equal(new Set(events.map(event => event.sessionId)).size, 1);
  assert.match(result.stdout, /Assistant: Saved your preference\./);
  assert.match(result.stderr, /session|event/i);
  assert.match(result.stderr, /not confirmed/i);
  assert.match(result.stderr, /may already be stored/i);
});

test('an empty final reply does not write a fabricated assistant session event', () => {
  const result = runDemo(`${remember}\n/quit\n`, { DEMO_TEST_SCENARIO: 'empty-reply' });
  assert.equal(result.status, 0, result.stderr);
  assertSessionEvents(result, ['USER'], [remember]);
  assert.equal(result.requests.filter(request => request.kind === 'model').length, 2);
  assert.match(result.stdout, /No final text reply/);
  assert.equal(result.stderr, '');
});

test('tool output supports forced color and explicit color disabling', () => {
  const input = `${remember}\n/quit\n`;
  const colored = runDemo(input, { FORCE_COLOR: '1' });
  assert.equal(colored.status, 0, colored.stderr);
  assert.equal(colored.stderr, '');
  for (const tool of ['add_session_event', 'create_memories']) {
    assert.match(colored.stdout, new RegExp(`\\x1b\\[36m[^\\n]*\\[memory\\] ${tool}[^\\n]*\\x1b\\[0m`));
  }
  assert.doesNotMatch(colored.stdout, /\x1b\[[0-9;]*mAssistant:/);
  for (const env of [{ FORCE_COLOR: '0' }, { FORCE_COLOR: '1', NO_COLOR: '1' }]) {
    const plain = runDemo(input, env);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /\x1b\[/);
  }
});

test('missing credentials produce an actionable startup error without network calls', () => {
  const result = runDemo('/quit\n', {
    ANTHROPIC_API_KEY: undefined, AGENT_MEMORY_API_KEY: undefined, AGENT_MEMORY_STORE_ID: undefined,
  });
  assert.equal(result.status, 1);
  for (const name of ['ANTHROPIC_API_KEY', 'AGENT_MEMORY_API_KEY', 'AGENT_MEMORY_STORE_ID']) {
    assert.ok(result.stderr.includes(name));
  }
  assert.deepEqual(result.requests, []);
});

test('invalid user IDs and endpoints fail before making requests', () => {
  const user = runDemo('/quit\n', { DEMO_USER_ID: 'invalid user' });
  assert.equal(user.status, 1);
  assert.match(user.stderr, /DEMO_USER_ID/);
  assert.deepEqual(user.requests, []);
  const endpoint = runDemo('/quit\n', { AGENT_MEMORY_URL: 'not-a-url' });
  assert.equal(endpoint.status, 1);
  assert.match(endpoint.stderr, /endpoint|AGENT_MEMORY_URL|configuration/i);
  assert.deepEqual(endpoint.requests, []);
});

test('/new and /quit do not call a model or memory service', () => {
  const result = runDemo('/new\n/quit\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /New conversation/);
  assert.deepEqual(result.requests, []);
});
