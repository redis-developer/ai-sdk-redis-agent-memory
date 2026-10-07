import type { AgentMemory } from '@redis-iris/agent-memory';
import { describe, expect, it, vi } from 'vitest';
import { createScopedMemory, resolveAgentMemoryClient } from '../src/scoped-memory.js';

const timestamp = new Date('2026-09-25T12:34:56.000Z');

function client(overrides: Partial<AgentMemory> = {}): AgentMemory {
  return {
    getSessionMemory: vi.fn(),
    getLongTermMemory: vi.fn(),
    getNamespace: vi.fn(),
    addSessionEvent: vi.fn(),
    searchLongTermMemory: vi.fn(),
    ...overrides,
  } as unknown as AgentMemory;
}

describe('scoped memory core', () => {
  it('resolves the same connection precedence and validates URLs before constructing a client', () => {
    const env = {
      AGENT_MEMORY_URL: 'https://environment.example.test',
      AGENT_MEMORY_STORE_ID: 'environment-store',
      AGENT_MEMORY_API_KEY: 'environment-key',
    };
    const resolved = resolveAgentMemoryClient(
      'https://argument.example.test', 'argument-store', 'argument-key', 1234, env,
    );

    expect(resolved._baseURL?.toString()).toBe('https://argument.example.test/');
    expect(() => resolveAgentMemoryClient('https://user:password@example.test', 'store', 'key', 1234, env)).toThrow('serverUrl');
    expect(() => resolveAgentMemoryClient(undefined, undefined, undefined, 1234, {})).toThrow('AGENT_MEMORY_API_KEY');
  });

  it('restores only a session whose owner and placement match the immutable scope', async () => {
    const getSessionMemory = vi.fn().mockResolvedValue({
      sessionId: 'session-1', ownerId: 'user-1', namespaceRef: { namespaceId: 'namespace-1' }, events: [],
    });
    const scoped = createScopedMemory(client({ getSessionMemory } as Partial<AgentMemory>), {
      userId: 'user-1', sessionId: 'session-1', namespaceId: 'namespace-1',
    });

    await expect(scoped.restoreSession({ signal: undefined, retries: { strategy: 'none' } })).resolves.toMatchObject({
      sessionId: 'session-1', ownerId: 'user-1',
    });
    expect(getSessionMemory).toHaveBeenCalledWith('session-1', false, {
      signal: undefined, retries: { strategy: 'none' },
    });

    getSessionMemory.mockResolvedValueOnce({
      sessionId: 'session-1', ownerId: 'another-user', namespaceRef: { namespaceId: 'namespace-1' }, events: [],
    });
    await expect(scoped.restoreSession()).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });

  it('searches personal memories with owner and namespace joined by all and validates every result', async () => {
    const searchLongTermMemory = vi.fn().mockResolvedValue({ items: [{
      id: 'memory-1', text: 'Prefers concise replies.', ownerId: 'user-1',
      namespaceRef: { namespaceId: 'namespace-1' }, createdAt: timestamp, updatedAt: timestamp,
    }] });
    const scoped = createScopedMemory(client({ searchLongTermMemory } as Partial<AgentMemory>), {
      userId: 'user-1', sessionId: 'current-session', namespaceId: 'namespace-1',
    });

    await expect(scoped.searchPersonalMemories('preferences', 5, {
      retries: { strategy: 'none' },
    })).resolves.toMatchObject({ items: [{ id: 'memory-1' }] });
    expect(searchLongTermMemory).toHaveBeenCalledWith({
      text: 'preferences', limit: 5, filterOp: 'all',
      filter: { ownerId: { eq: 'user-1' }, namespaceRef: { eq: 'namespace-1' } },
    }, { retries: { strategy: 'none' } });

    searchLongTermMemory.mockResolvedValueOnce({ items: [{
      id: 'memory-2', text: 'Foreign.', ownerId: 'another-user',
      namespaceRef: { namespaceId: 'namespace-1' }, createdAt: timestamp, updatedAt: timestamp,
    }] });
    await expect(scoped.searchPersonalMemories('preferences', 5)).rejects.toMatchObject({ code: 'INVALID_SCOPE' });
  });

  it('optionally postflights a newly created session without changing the legacy append path', async () => {
    const notFound = Object.assign(new Error('missing'), { statusCode: 404 });
    const getSessionMemory = vi.fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ sessionId: 'session-1', ownerId: 'user-1', events: [] });
    const addSessionEvent = vi.fn().mockResolvedValue({ event: {
      eventId: 'event-1', sessionId: 'session-1', actorId: 'user-1', role: 'USER',
      content: [{ text: 'Hello.' }], createdAt: timestamp, systemTimestamp: timestamp,
    } });
    const scoped = createScopedMemory(client({ getSessionMemory, addSessionEvent } as Partial<AgentMemory>), {
      userId: 'user-1', sessionId: 'session-1',
    });

    await scoped.appendSessionEvent({
      actorId: 'user-1', role: 'USER', content: [{ text: 'Hello.' }],
    }, { retries: { strategy: 'none' }, postflightNewSession: true });

    expect(getSessionMemory).toHaveBeenCalledTimes(2);
    expect(addSessionEvent).toHaveBeenCalledTimes(1);
    expect(addSessionEvent.mock.invocationCallOrder[0]).toBeGreaterThan(getSessionMemory.mock.invocationCallOrder[0]!);
    expect(getSessionMemory.mock.invocationCallOrder[1]).toBeGreaterThan(addSessionEvent.mock.invocationCallOrder[0]!);

    getSessionMemory.mockReset().mockRejectedValueOnce(notFound);
    addSessionEvent.mockClear();
    await scoped.appendSessionEvent({
      actorId: 'user-1', role: 'USER', content: [{ text: 'Legacy.' }],
    }, { retries: { strategy: 'none' } });
    expect(getSessionMemory).toHaveBeenCalledTimes(1);
    expect(addSessionEvent).toHaveBeenCalledTimes(1);
  });

  it('does not start a POST when an ignored preflight settles after the caller aborts', async () => {
    let release!: () => void;
    const preflight = new Promise<never>((_resolve, reject) => {
      release = () => reject(Object.assign(new Error('missing'), { statusCode: 404 }));
    });
    const getSessionMemory = vi.fn().mockReturnValue(preflight);
    const addSessionEvent = vi.fn();
    const scoped = createScopedMemory(client({ getSessionMemory, addSessionEvent } as Partial<AgentMemory>), {
      userId: 'user-1', sessionId: 'session-1',
    });
    const controller = new AbortController();
    const appending = scoped.appendSessionEvent({
      actorId: 'user-1', role: 'USER', content: [{ text: 'Hello.' }],
    }, { signal: controller.signal, retries: { strategy: 'none' } });

    controller.abort(new DOMException('Cancelled.', 'AbortError'));
    release();

    await expect(appending).rejects.toHaveProperty('name', 'AbortError');
    expect(addSessionEvent).not.toHaveBeenCalled();
  });
});
