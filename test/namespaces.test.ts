import type { AgentMemory } from '@redis-iris/agent-memory';
import type { Namespace } from '@redis-iris/agent-memory/models';
import type { ToolSet } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createNamespaceTools, type NamespaceToolOptions } from '../src/namespaces.js';

const now = new Date('2026-09-25T12:00:00Z');
function namespace(overrides: Partial<Namespace> = {}): Namespace {
  return {
    namespaceId: 'root-1', rootId: 'root-1', name: 'My notes', path: 'My notes',
    ownerId: 'user-1', scope: 'PERSONAL', state: 'ACTIVE', revision: 1,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function setup(options: Partial<NamespaceToolOptions> = {}, records: Namespace[] = [namespace()]) {
  const stored = new Map(records.map(record => [record.namespaceId, record]));
  const client = {
    getNamespace: vi.fn(async (id: string, _options?: unknown) => {
      const record = stored.get(id);
      if (!record) throw new Error(`Missing fixture namespace ${id}`);
      return { namespace: record };
    }),
    listNamespaces: vi.fn(async (..._args: unknown[]) => ({ items: records })),
    createNamespace: vi.fn(async (body: Record<string, unknown>, _options?: unknown) => ({
      namespace: namespace({ namespaceId: 'created-namespace', ...body }),
    })),
    updateNamespace: vi.fn(async (id: string, body: Record<string, unknown>, _options?: unknown) => ({
      namespace: namespace({ namespaceId: id, ...body }),
    })),
    deleteNamespace: vi.fn(async (_id: string, _options?: unknown) => undefined),
    moveLongTermMemories: vi.fn(async (body: { memoryIds: string[] }, _options?: unknown) => ({
      moved: body.memoryIds,
    })),
  };
  const assertMemory = vi.fn(async (_id: string, _signal?: AbortSignal) => undefined);
  const tools = createNamespaceTools(client as unknown as AgentMemory, {
    allowDeletes: true, assertMemory, ...options,
  });
  return { tools, client, assertMemory };
}

async function run(tools: ToolSet, name: string, input: unknown, abortSignal?: AbortSignal): Promise<any> {
  const definition = tools[name];
  if (!definition?.execute) throw new Error(`Missing tool: ${name}`);
  const schema = definition.inputSchema as { parseAsync(value: unknown): Promise<unknown> };
  return definition.execute(await schema.parseAsync(input), {
    toolCallId: 'namespace-test', messages: [], abortSignal,
  });
}

describe('namespace scope enforcement', () => {
  it('resolves the personal owner from a child namespace root', async () => {
    const root = namespace();
    const child = namespace({ namespaceId: 'child-1', parentId: root.namespaceId, ownerId: undefined });
    const { tools, client } = setup({ ownerId: 'user-1' }, [root, child]);
    expect(await run(tools, 'get_namespace', { namespaceId: child.namespaceId })).toEqual({ namespace: child });
    expect(client.getNamespace.mock.calls.map(([id]) => id)).toEqual(['child-1', 'root-1']);
  });

  it('rejects another owner through the parent root before exposing a child', async () => {
    const root = namespace({ ownerId: 'someone-else' });
    const child = namespace({ namespaceId: 'child-1', parentId: root.namespaceId, ownerId: undefined });
    const { tools } = setup({ ownerId: 'user-1' }, [root, child]);
    await expect(run(tools, 'get_namespace', { namespaceId: child.namespaceId })).rejects.toThrow();
  });

  it.each(['get_namespace', 'update_namespace', 'delete_namespace', 'move_memories'])(
    'rejects shared namespaces for owner-scoped %s', async (operation) => {
      const { tools, client } = setup({ ownerId: 'user-1' }, [namespace({ scope: 'SHARED', ownerId: undefined })]);
      await expect(run(tools, operation, {
        namespaceId: 'root-1', name: 'renamed', memoryIds: ['memory-1'],
      })).rejects.toThrow();
      expect(client.updateNamespace).not.toHaveBeenCalled();
      expect(client.deleteNamespace).not.toHaveBeenCalled();
      expect(client.moveLongTermMemories).not.toHaveBeenCalled();
    },
  );

  it('injects personal root filters and preserves pagination', async () => {
    const { tools, client } = setup({ ownerId: 'user-1' });
    client.listNamespaces.mockResolvedValueOnce({ items: [namespace()], nextPageToken: 'next' } as any);
    const result = await run(tools, 'list_namespaces', { limit: 20, pageToken: 'previous' });
    expect(client.listNamespaces).toHaveBeenCalledWith(undefined, 'PERSONAL', 'user-1', 20, 'previous', { signal: undefined });
    expect(result.nextPageToken).toBe('next');
  });

  it('lists children without forbidden root filters after verifying their parent', async () => {
    const root = namespace();
    const child = namespace({ namespaceId: 'child-1', parentId: root.namespaceId, ownerId: undefined });
    const { tools, client } = setup({ ownerId: 'user-1' }, [root, child]);
    client.listNamespaces.mockResolvedValueOnce({ items: [child] });
    const result = await run(tools, 'list_namespaces', { parentId: 'root-1' });
    expect(client.listNamespaces).toHaveBeenCalledWith('root-1', undefined, undefined, undefined, undefined, { signal: undefined });
    expect(result.items).toEqual([child]);
  });

  it('fails closed if a server list includes an out-of-scope root', async () => {
    const { tools, client } = setup({ ownerId: 'user-1' });
    client.listNamespaces.mockResolvedValueOnce({ items: [namespace({ ownerId: 'someone-else' })] });
    await expect(run(tools, 'list_namespaces', {})).rejects.toThrow();
  });

  it.each([
    { scope: 'SHARED' },
    { ownerId: 'someone-else' },
    { parentId: 'root-1', scope: 'PERSONAL' },
  ])('rejects conflicting listing filters before a request: %j', async (input) => {
    const { tools, client } = setup({ ownerId: 'user-1' });
    await expect(run(tools, 'list_namespaces', input)).rejects.toThrow();
    expect(client.listNamespaces).not.toHaveBeenCalled();
  });

  it('creates an owner-bound personal root without model-supplied identity', async () => {
    const { tools, client } = setup({ ownerId: 'user-1' });
    await run(tools, 'create_namespace', { name: 'Preferences' });
    expect(client.createNamespace).toHaveBeenCalledWith({
      name: 'Preferences', scope: 'PERSONAL', ownerId: 'user-1',
    }, { signal: undefined });
  });

  it('creates a child with only name and verified parent ID', async () => {
    const { tools, client } = setup({ ownerId: 'user-1' });
    await run(tools, 'create_namespace', { name: 'Preferences', parentId: 'root-1' });
    expect(client.getNamespace).toHaveBeenCalledWith('root-1', { signal: undefined });
    expect(client.createNamespace).toHaveBeenCalledWith({ name: 'Preferences', parentId: 'root-1' }, { signal: undefined });
  });

  it.each([
    { name: 'Preferences', scope: 'SHARED' },
    { name: 'Preferences', ownerId: 'someone-else' },
    { name: 'Preferences', path: 'Notes/Preferences' },
    { path: 'Notes/Preferences', parentId: 'root-1' },
  ])('rejects invalid or out-of-scope namespace creation: %j', async (input) => {
    const { tools, client } = setup({ ownerId: 'user-1' });
    await expect(run(tools, 'create_namespace', input)).rejects.toThrow();
    expect(client.createNamespace).not.toHaveBeenCalled();
  });

  it('lists only the fixed namespace instead of asking the service for roots', async () => {
    const { tools, client } = setup({ ownerId: 'user-1', namespaceId: 'root-1' });
    expect(await run(tools, 'list_namespaces', {})).toEqual({ items: [namespace()] });
    expect(client.listNamespaces).not.toHaveBeenCalled();
  });

  it.each([
    ['list_namespaces', { parentId: 'root-1' }],
    ['list_namespaces', { pageToken: 'next' }],
    ['create_namespace', { name: 'Child', parentId: 'root-1' }],
    ['get_namespace', { namespaceId: 'other' }],
    ['update_namespace', { namespaceId: 'other', name: 'Changed' }],
    ['move_memories', { namespaceId: 'other', memoryIds: ['memory-1'] }],
  ])('blocks fixed-namespace escapes in %s', async (operation, input) => {
    const { tools, client, assertMemory } = setup({ namespaceId: 'root-1' });
    await expect(run(tools, operation as string, input)).rejects.toThrow();
    expect(client.getNamespace).not.toHaveBeenCalled();
    expect(client.createNamespace).not.toHaveBeenCalled();
    expect(client.updateNamespace).not.toHaveBeenCalled();
    expect(client.moveLongTermMemories).not.toHaveBeenCalled();
    expect(assertMemory).not.toHaveBeenCalled();
  });

  it('checks every source memory before submitting a move batch', async () => {
    const { tools, client, assertMemory } = setup({ ownerId: 'user-1' });
    assertMemory.mockRejectedValueOnce(new Error('Not permitted'));
    await expect(run(tools, 'move_memories', { namespaceId: 'root-1', memoryIds: ['foreign-memory'] })).rejects.toThrow();
    expect(client.moveLongTermMemories).not.toHaveBeenCalled();
  });

  it('prevents partial mutation when a later memory in a batch fails authorization', async () => {
    const assertMemory = vi.fn(async (id: string) => {
      if (id === 'foreign-memory') throw new Error('Not permitted');
    });
    const { tools, client } = setup({ ownerId: 'user-1', assertMemory });
    await expect(run(tools, 'move_memories', {
      namespaceId: 'root-1', memoryIds: ['my-memory', 'foreign-memory'],
    })).rejects.toThrow();
    expect(assertMemory.mock.calls.map(([id]) => id)).toEqual(['my-memory', 'foreign-memory']);
    expect(client.moveLongTermMemories).not.toHaveBeenCalled();
  });

  it('preserves partial move failures rather than claiming the whole batch succeeded', async () => {
    const { tools, client, assertMemory } = setup({ ownerId: 'user-1' });
    const response = { moved: ['memory-1'], errors: [{ id: 'memory-2', error: 'Concurrent update' }] };
    client.moveLongTermMemories.mockResolvedValueOnce(response);
    const result = await run(tools, 'move_memories', {
      namespaceId: 'root-1', memoryIds: ['memory-1', 'memory-2'],
    });
    expect(result).toEqual(response);
    expect(assertMemory).toHaveBeenCalledTimes(2);
    expect(client.moveLongTermMemories).toHaveBeenCalledWith({
      memoryIds: ['memory-1', 'memory-2'], namespaceRef: { namespaceId: 'root-1' },
    }, { signal: undefined });
  });

  it('rejects archived destinations before checking or moving memories', async () => {
    const { tools, client, assertMemory } = setup({}, [namespace({ state: 'ARCHIVED' })]);
    await expect(run(tools, 'move_memories', { namespaceId: 'root-1', memoryIds: ['memory-1'] })).rejects.toThrow();
    expect(assertMemory).not.toHaveBeenCalled();
    expect(client.moveLongTermMemories).not.toHaveBeenCalled();
  });

  it('omits delete_namespace when deletion is disabled', () => {
    const { tools } = setup({ allowDeletes: false });
    expect(tools.delete_namespace).toBeUndefined();
    expect(tools.get_namespace).toBeDefined();
  });

  it('forwards cancellation to scope checks and the final mutation', async () => {
    const { tools, client } = setup({ ownerId: 'user-1' });
    const signal = new AbortController().signal;
    await run(tools, 'update_namespace', { namespaceId: 'root-1', name: 'Renamed' }, signal);
    expect(client.getNamespace).toHaveBeenCalledWith('root-1', { signal });
    expect(client.updateNamespace).toHaveBeenCalledWith('root-1', { name: 'Renamed' }, { signal });
  });
});
