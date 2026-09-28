# Redis Agent Memory for Vercel's AI SDK

This integration provides short-term and long-term memory tools to agents developed with Vercel's [AI SDK](https://ai-sdk.dev/).

## Installation

Requires **Node.js 22+**, **AI SDK 7.0.114+ (7.x)**, and **Zod 4.1.8+ (4.x)**. This is a server-side, ESM-only package with TypeScript declarations.

After the first npm release:

```sh
npm install ai-sdk-redis-agent-memory ai@^7.0.114 zod@^4.1.8
```

Before that release, [build and install a local tarball](#development). Provision a Redis Agent Memory store in [Redis Cloud](https://cloud.redis.io/#/agent-memory), then set `AGENT_MEMORY_API_KEY` and `AGENT_MEMORY_STORE_ID` in your server environment. Set `AGENT_MEMORY_URL` if your store uses a different endpoint.

## Quick start

This example uses Anthropic directly; install its provider with `npm install @ai-sdk/anthropic@^4` and set `ANTHROPIC_API_KEY`. Other AI SDK 7-compatible model providers work with the same toolset.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { RedisAgentMemory, irisMemoryInstructions } from 'ai-sdk-redis-agent-memory';

// Your application supplies these from authenticated user/conversation state.
const userId = 'user-123';
const sessionId = 'conversation-456';
const agentId = 'assistant-1';

const agent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4-5'),
  tools: new RedisAgentMemory(
    // Defaults to AGENT_MEMORY_URL or https://gcp-us-east4.memory.redis.io.
    process.env.AGENT_MEMORY_URL,
    process.env.AGENT_MEMORY_STORE_ID,
    process.env.AGENT_MEMORY_API_KEY,
    { userId, sessionId },
  ),
  instructions: `${irisMemoryInstructions}
Current user and memory owner: ${userId}
Current session: ${sessionId}
Current assistant actor: ${agentId}`,
  stopWhen: isStepCount(8),
});

const result = await agent.generate({
  prompt: 'Remember that I prefer TypeScript examples.',
});
console.log(result.finalStep.text);
```

The model decides when to use a memory tool. Instructions guide that decision; they do not force retrieval or storage on every turn. If your application requires every message to be recorded, call the official SDK from your request handler and tell the agent not to duplicate those events. This toolset does not automatically load conversation history into the model context.

## Combining tools

The class implements the AI SDK `ToolSet` string index signature. Its own enumerable properties are exclusively tools; API credentials and the SDK client stay in closures. `createRedisAgentMemoryTools(serverUrl?, storeId?, apiKey?, scope?, options?)` returns an equivalent plain tool map, useful for spreading or selectively including tools:

```ts
import { createRedisAgentMemoryTools } from 'ai-sdk-redis-agent-memory';
const memory = createRedisAgentMemoryTools();
const tools = { search_memories: memory.search_memories!, get_memory: memory.get_memory! };
```

This is a server-side package. Never put the Iris API key in a frontend bundle.

## Configuration

The factory and class constructor accept the same positional arguments:

```ts
createRedisAgentMemoryTools(serverUrl, storeId, apiKey, scope, options);
new RedisAgentMemory(serverUrl, storeId, apiKey, scope, options);
```

Omit an argument or pass `undefined` to use its default. The API key and store ID must be supplied as arguments or through the environment.

| Argument | Default / behavior |
| --- | --- |
| `serverUrl` | `AGENT_MEMORY_URL`, then production US East endpoint |
| `storeId` | `AGENT_MEMORY_STORE_ID`; required through argument or environment |
| `apiKey` | `AGENT_MEMORY_API_KEY`; required through argument or environment |
| `scope` | `{}`; optional fixed user, session, and namespace boundaries |
| `options` | `{}`; deletion and namespace administration tools are disabled |

The `scope` argument accepts:

| Property | Default / behavior |
| --- | --- |
| `scope.userId` | Optional fixed application user ID; used for memory ownership checks and search filters, and as the actor ID when starting a USER session |
| `scope.sessionId` | Optional fixed conversation; also associates new memories with this session |
| `scope.namespaceId` | Optional fixed namespace resource ID |
| `scope.namespace` | Optional fixed legacy namespace label; mutually exclusive with `namespaceId` |

`RedisAgentMemoryOptions` accepts:

| Option | Default / behavior |
| --- | --- |
| `allowDeletes` | `false`; set `true` to expose delete tools |
| `namespaceTools` | `false`; set `true` to expose namespace administration and memory moves |
| `timeoutMs` | `30000` per HTTP request; must be positive and finite |

For example, `createRedisAgentMemoryTools(serverUrl, storeId, apiKey, scope, { allowDeletes: true })` enables deletion tools. Namespace deletion requires both switches to be `true`.

Configuration is copied at construction. Create a scoped toolset for each authenticated request/conversation; do not mutate a shared instance's scope. AI SDK `abortSignal` is forwarded to every Iris request. SDK defaults disable automatic retries, avoiding duplicate session appends after uncertain network outcomes.

## Tool reference

All parameter names are camelCase. IDs remain visible to the model; fixed constructor scopes cannot be overridden. The three deletion tools below are exposed only when `options.allowDeletes` is `true`.

| Tool | Parameters and result |
| --- | --- |
| `get_memory_context` | `{}` → configured IDs and identity rules, no secrets |
| `start_session` | `{actorId, text, sessionId?, namespace?, namespaceRef?}` → `{event}`; omit sessionId to let Iris generate it |
| `add_session_event` | `{actorId, role, content: [{text}], sessionId?, createdAt?, metadata?, namespace?, namespaceRef?}` → `{event}` |
| `get_session_event` | `{sessionId?, eventId}` → `{event}` |
| `get_session_memory` | `{sessionId?, includeSummarisedEvents?}` → session, events, optional summary |
| `list_sessions` | `{ownerId?, includeAll?, limit?, pageToken?}` → `{items: string[], total, nextPageToken?}` |
| `create_memories` | `{memories: [...]}` without IDs → `{memoryIds, created, errors?}`; UUIDs are generated automatically |
| `get_memory` | `{memoryId}` → memory record |
| `search_memories` | `{text?, filter?, filterOp?, similarityThreshold?, limit?, pageToken?}` → `{items, nextPageToken?}` |
| `update_memory` | `{memoryId, changes: {...}}` → updated memory record |
| `delete_memories` | `{memoryIds: [...]}` → `{deleted, errors?}` |
| `delete_session_event` | `{sessionId?, eventId}` → deletion confirmation |
| `delete_session_memory` | `{sessionId?}` → deletion confirmation |

`sessionId` is required for retrieval/deletion unless fixed in the scope. `role` is `USER`, `ASSISTANT`, or `SYSTEM`. `createdAt` accepts an ISO 8601 string with timezone and defaults to the current time. Session/owner IDs follow the server's 1–64 alphanumeric-or-hyphen convention; actor IDs accept 1–255 characters.

A create record contains:

```ts
{
  text: 'The user prefers TypeScript.',
  ownerId: 'user-123',               // Optional when scope.userId is set
  sessionId: 'conversation-456',    // Optional; defaults to scoped session
  memoryType: 'semantic',           // Optional; registered custom types also work
  topics: ['programming'],
  attributes: { /* fields matching your custom type, if applicable */ },
  namespaceRef: { namespaceId: 'your-namespace-id' },
}
```

The wrapper generates a UUID v4 for each create record. The agent does not supply an `id`. The returned `memoryIds` array lists all generated IDs in input order, including any failed records; `created` contains successful IDs and `errors` contains per-ID failures. Keep successful IDs for later retrieval, updates, and deletion.

Each `create_memories` invocation generates fresh IDs. If a request times out or its outcome is uncertain, search for the memories before retrying to avoid duplicates. Retry only records confirmed to have failed.

Bulk create/delete accepts 1–100 records/IDs and preserves the server's per-record errors. Text accepts 1–50,000 characters; topics accept up to 50 tags. Updates support `text`, `memoryType`, `topics`, `ownerId`, `sessionId`, and namespace placement. An empty `sessionId` or legacy `namespace` clears it when not fixed by scope. Updating custom extraction-worker fields is deliberately outside the agent toolset; use the official SDK's worker endpoint for that workflow.

Search filters support `ownerId`, `sessionId`, legacy `namespace`, `topics`, and `memoryType` with exactly one of `{eq}`, `{ne}`, `{in: [...]}`, or `{all: [...]}`. `namespaceRef` supports `{eq}` or `{in}`. Use `unnamespaced` without namespace selectors. Date comparisons accept ISO strings:

```ts
{
  text: 'preferred programming language',
  filter: {
    ownerId: { eq: 'user-123' },
    topics: { in: ['programming'] },
    createdAt: { gte: '2026-01-01T00:00:00Z' },
    attributes: { confirmed: { boolean: true } },
  },
  filterOp: 'all',
  limit: 10,
}
```

Attribute filters accept exactly one of `{string}`, `{number}`, `{boolean}`, or `{list: string[]}` per field. Omit `text` to list/filter without a semantic query. Pagination uses the returned opaque `nextPageToken` with the same search parameters.

## Identity and scope behavior

`scope.userId` identifies the application user. The tools use that identity in role-specific fields: `ownerId` for the user's memories, sessions, and PERSONAL namespaces, and `actorId` for their USER events. Memory creation supplies `ownerId` automatically from `scope.userId`; session events still require an explicit `actorId`.

Append `irisMemoryInstructions` to your agent's instructions and supply current user/agent/session IDs in trusted application context. A USER event uses the human user's ID as `actorId`; an ASSISTANT event uses the agent's ID. The first event establishes immutable session ownership, so initialize user-owned sessions with the user's message. With `scope.userId` set, the wrapper requires a new session to start with a USER event whose `actorId` matches that user ID.

The host must retain session IDs between requests. An agent generating a session ID does not itself make that ID persistent across future model calls. Persist the IDs and conversation history in your application's storage and reuse them on subsequent requests.

`scope.sessionId` restricts session operations but **does not filter long-term recall by session**, allowing recall from earlier conversations. To limit long-term recall to one conversation, pass an explicit `filter.sessionId`.

User/namespace-scoped searches require `filterOp: 'all'`; an OR filter could bypass a fixed owner predicate and is rejected. Direct-ID reads, updates, and deletes check existing ownership/placement before returning or mutating a resource. User-scoped resource placements require a PERSONAL namespace owned by that user. A legacy namespace label is a grouping value and has no resource ownership to inspect.

With a fixed session, `list_sessions` returns only that session. With a namespace scope and no fixed session it rejects listing, because Iris has no namespace filter for this endpoint; use known IDs. Unscoped store-wide listing requires explicit `includeAll: true`.

Scopes provide application guardrails and use preflight reads. They are not a substitute for authentication, store-level permissions, or protection against concurrent ownership changes made by other clients.

## Optional namespace tools

Set `namespaceTools: true` in the fifth argument (`options`) to add:

| Tool | Parameters |
| --- | --- |
| `list_namespaces` | `{parentId?, scope?, ownerId?, limit?, pageToken?}` |
| `get_namespace` | `{namespaceId}` |
| `create_namespace` | `{name?, path?, scope?, parentId?, ownerId?}` |
| `update_namespace` | `{namespaceId, name?, state?: 'ARCHIVED'}` |
| `move_memories` | `{memoryIds, namespaceId}` |
| `delete_namespace` | `{namespaceId}`; omitted when deletes are disabled |

Create roots with name/scope, children with name/parentId, or a hierarchy with path/scope. Namespace scopes are `PERSONAL` and `SHARED`; PERSONAL roots require an owner. User-scoped tools restrict access to that user's personal namespaces, including child namespaces inheriting root ownership. A fixed namespace scope prevents creation or moving memories outside that namespace. Legacy namespace scopes cannot enable resource administration tools. Archive and delete operations follow the server's rules; deletion is for empty leaf namespaces.

## Failures and cancellation

Tool execution throws `RedisAgentMemoryToolError` with a safe `code`, message, and optional HTTP `statusCode`. Upstream headers, bodies, and API keys are not passed into model context. Cancellation is surfaced as `AbortError`. Bulk results retain partial errors so the agent can identify individual failures. An uncertain memory creation or session append can already have committed: reconcile its outcome before retrying.

Automatic summary/promotion behavior belongs to the Iris store configuration. Deleting session history does not cascade to promoted long-term memories. The package has no LLM dependency of its own and does not configure store promotion workers, store administration, or custom extraction workers.

## Development

```sh
git clone https://github.com/redis-developer/ai-sdk-redis-agent-memory.git
cd ai-sdk-redis-agent-memory
npm ci
npm run check
npm pack
```

Install the resulting tarball in your application with `npm install /path/to/ai-sdk-redis-agent-memory-0.1.0.tgz`. It contains the compiled library, declarations, source maps, source files, and package documentation. No demo application or credentials are included.

See [CONTRIBUTING.md](https://github.com/redis-developer/ai-sdk-redis-agent-memory/blob/main/CONTRIBUTING.md) for the repository layout, commands, and release process. The tests use mocked HTTP and model boundaries and do not require API credentials.

## License

[MIT](LICENSE).
