import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypoint = fileURLToPath(new URL('../index.mjs', import.meta.url));
const preload = fileURLToPath(new URL('./fixtures/services.mjs', import.meta.url));
const seededSession = '11111111-1111-4111-8111-111111111111';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runDemo(input, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'redis-memory-provider-demo-test-'));
  const traceFile = join(directory, 'requests.jsonl');
  try {
    const env = {
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: 'fake-anthropic-key',
      AGENT_MEMORY_API_KEY: 'fake-memory-key',
      AGENT_MEMORY_STORE_ID: 'demo-test-store',
      AGENT_MEMORY_URL: 'https://memory.example.test',
      DEMO_USER_ID: 'demo-test-user',
      DEMO_TEST_TRACE: traceFile,
      NO_COLOR: '1',
      ...overrides,
    };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    const result = spawnSync(process.execPath, ['--import', preload, entrypoint], {
      cwd: directory, env, input, encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
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

const requestsOf = (result, kind) => result.requests.filter(request => request.kind === kind);
const occurrences = (text, value) => text.split(value).length - 1;

test('fresh request models from one factory restore the same session once per turn without tools or local message history', () => {
  const result = runDemo('First question\nSecond question\n/quit\n');
  assert.equal(result.status, 0, result.stderr);
  const models = requestsOf(result, 'model');
  assert.equal(models.length, 2);
  assert.ok(models.every(request => request.body.model === 'claude-sonnet-4-5'));
  assert.ok(models.every(request => request.url === 'https://api.anthropic.com/v1/messages'));
  assert.ok(models.every(request => request.body.tools === undefined));
  assert.equal([...result.stdout.matchAll(/\[memory\] session\.restore /g)].length, 2);
  assert.deepEqual(requestsOf(result, 'session-append').map(request => request.body.role),
    ['USER', 'ASSISTANT', 'USER', 'ASSISTANT']);
  assert.equal(new Set(requestsOf(result, 'session-append').map(request => request.body.sessionId)).size, 1);
  assert.doesNotMatch(JSON.stringify(models[0].body), /Earlier answer/);
  assert.match(JSON.stringify(models[1].body.messages), /First question/);
  assert.match(JSON.stringify(models[1].body.messages), /First answer/);
  assert.match(JSON.stringify(models[1].body.messages), /Second question/);
  assert.equal(occurrences(JSON.stringify(models[0].body.messages), 'First question'), 1);
  assert.equal(occurrences(JSON.stringify(models[1].body.messages), 'First question'), 1);
  assert.equal(occurrences(JSON.stringify(models[1].body.messages), 'First answer.'), 1);
  assert.equal(occurrences(JSON.stringify(models[1].body.messages), 'Second question'), 1);
  const searches = requestsOf(result, 'memory-search');
  assert.equal(searches.length, 2);
  assert.ok(searches.every(request => request.body.filter.ownerId.eq === 'demo-test-user'));
  assert.match(result.stdout, /Assistant: First answer\./);
  assert.match(result.stdout, /Assistant: Second answer\./);
});

test('/new starts independent session history while retaining long-term memory recall', () => {
  const result = runDemo('First question\n/new\nWhat do I prefer?\n/quit\n');
  assert.equal(result.status, 0, result.stderr);
  const appends = requestsOf(result, 'session-append');
  assert.match(appends[0].body.sessionId, uuid);
  assert.match(appends[2].body.sessionId, uuid);
  assert.notEqual(appends[0].body.sessionId, appends[2].body.sessionId);
  const secondModel = requestsOf(result, 'model')[1];
  assert.doesNotMatch(JSON.stringify(secondModel.body), /First question|First answer/);
  assert.match(JSON.stringify(secondModel.body), /Prefers concise TypeScript examples/);
  assert.match(result.stdout, /New session/);
  assert.match(result.stdout, /Assistant: You prefer concise TypeScript examples\./);
});

test('DEMO_SESSION_ID resumes a validated session and startup explains continuation', () => {
  const result = runDemo('Continue\n/quit\n', { DEMO_SESSION_ID: seededSession });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Session: ${seededSession}`));
  assert.match(result.stdout, new RegExp(`DEMO_SESSION_ID=${seededSession}`));
  assert.ok(requestsOf(result, 'session-append').every(request => request.body.sessionId === seededSession));
  assert.match(JSON.stringify(requestsOf(result, 'model')[0].body.messages), /Earlier session answer/);
});

test('missing credentials and invalid local configuration make zero network calls', () => {
  for (const { overrides, message } of [
    { overrides: { ANTHROPIC_API_KEY: undefined, AGENT_MEMORY_API_KEY: undefined, AGENT_MEMORY_STORE_ID: undefined }, message: /Set ANTHROPIC_API_KEY/ },
    { overrides: { DEMO_SESSION_ID: 'not-a-uuid' }, message: /DEMO_SESSION_ID must be a UUID/ },
    { overrides: { DEMO_USER_ID: 'not a valid user' }, message: /DEMO_USER_ID must contain/ },
    { overrides: { AGENT_MEMORY_URL: 'https://name:password@memory.example.test' }, message: /Could not initialize Redis Agent Memory/ },
  ]) {
    const result = runDemo('/quit\n', overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.requests.length, 0);
    assert.match(result.stderr, message);
  }
});

test('a foreign-owned restored session fails as Redis scope enforcement without calling Anthropic', () => {
  const result = runDemo('Hello\n/quit\n', { DEMO_TEST_SCENARIO: 'foreign-owner' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requestsOf(result, 'model').length, 0);
  assert.match(result.stderr, /Redis Agent Memory request failed/);
  assert.match(result.stderr, /SESSION_SCOPE_MISMATCH/);
  assert.match(result.stderr, /configured user\/session scope/);
  assert.match(result.stderr, /memory write may have succeeded/);
  assert.doesNotMatch(result.stderr, /Anthropic request failed|ANTHROPIC_API_KEY/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-response-body/);
});

test('ANTHROPIC_MODEL overrides the documented default model', () => {
  const result = runDemo('Hello\n/quit\n', { ANTHROPIC_MODEL: 'claude-test-override' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requestsOf(result, 'model')[0].body.model, 'claude-test-override');
  assert.match(result.stdout, /Model: claude-test-override/);
});

test('a model failure is not retried and records no assistant event', () => {
  const result = runDemo('private prompt\n/quit\n', { DEMO_TEST_SCENARIO: 'model-failure' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requestsOf(result, 'model').length, 1);
  assert.deepEqual(requestsOf(result, 'session-append').map(request => request.body.role), ['USER']);
  assert.match(result.stderr, /Anthropic request failed/);
  assert.match(result.stderr, /ANTHROPIC_API_KEY|ANTHROPIC_MODEL|status\.claude\.com/);
  assert.doesNotMatch(result.stdout, /Assistant:/);
});

test('read and write failures are best effort and diagnostics never leak secrets or bodies', () => {
  for (const scenario of ['read-failure', 'write-failure']) {
    const result = runDemo('Hello\n/quit\n', {
      DEMO_TEST_SCENARIO: scenario,
      ANTHROPIC_API_KEY: 'anthropic-secret-sentinel',
      AGENT_MEMORY_API_KEY: 'memory-secret-sentinel',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requestsOf(result, 'model').length, 1);
    assert.match(result.stdout, /Assistant: First answer\./);
    assert.match(result.stdout + result.stderr, /\[memory\] (session\.restore|memory\.search|session\.(?:user|assistant)\.write) (?:unavailable|failure)/);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /anthropic-secret-sentinel|memory-secret-sentinel|private-response-body/);
    assert.doesNotMatch(output, /Details:|stack|headers/i);
  }
});


test('a failed turn does not leak its USER state or snapshot into the next request', () => {
  const result = runDemo('Failed question\nNext question\n/quit\n', { DEMO_TEST_SCENARIO: 'first-model-failure' });
  assert.equal(result.status, 0, result.stderr);
  const models = requestsOf(result, 'model');
  assert.equal(models.length, 2);
  assert.equal(requestsOf(result, 'memory-search').length, 2);
  const appends = requestsOf(result, 'session-append');
  assert.deepEqual(appends.map(request => request.body.role), ['USER', 'USER', 'ASSISTANT']);
  assert.deepEqual(appends.slice(0, 2).map(request => request.body.content), [
    [{ text: 'Failed question' }], [{ text: 'Next question' }],
  ]);
  assert.equal(new Set(appends.map(request => request.body.sessionId)).size, 1);
  assert.equal(occurrences(JSON.stringify(models[1].body.messages), 'Failed question'), 1);
  assert.equal(occurrences(JSON.stringify(models[1].body.messages), 'Next question'), 1);
  assert.match(result.stderr, /Anthropic request failed/);
  assert.match(result.stdout, /Assistant: Second answer\./);
});

test('configuration and session commands make no model or memory calls', () => {
  const result = runDemo('/new\n/clear\n/quit\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 0);
  assert.match(result.stdout, /New session/);
});
