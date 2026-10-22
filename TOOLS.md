# Redis Agent Memory Tools for Vercel's AI SDK

[Redis Agent Memory](https://redis.io/agent-memory/), a part of the [Iris suite](https://redis.io/iris/), provides a managed memory layer that gives agents intelligent short-term memory and persistent context across conversations.
It allows AI agents to combine session history with long-term memories so they can recall user preferences, retain useful facts, and pick up where they left off.

This integration provides tools that add Redis Agent Memory to agents built with Vercel's [AI SDK](https://ai-sdk.dev/).
The tools are created by the same server-side `createRedisAgentMemory(...)` factory.
Use the tools either to delegate memory management entirely to your AI agent, or for implementing a desired custom behavior.

## Installation

Follow the [steps in the README.md](README.md#installation).

## Quick start

These examples use Anthropic directly; install its provider with `npm install @ai-sdk/anthropic@^4` and set `ANTHROPIC_API_KEY`.
Other AI SDK 7-compatible configured models work with the same APIs. Model-name strings are not accepted.

### Agent-managed session recording (no hooks)

Give the agent the memory tools and let it decide when to record session events or save long-term facts.
Tools do not require a configured model.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemory, instructions } from 'ai-sdk-redis-agent-memory';

const userId = 'user-123';
const sessionId = 'conversation-456';
const agentId = 'assistant-1';

const memory = createRedisAgentMemory({
  serverUrl: process.env.AGENT_MEMORY_URL,
  storeId: process.env.AGENT_MEMORY_STORE_ID,
  apiKey: process.env.AGENT_MEMORY_API_KEY,
});
const tools = memory.tools({ scope: { userId, sessionId } });

const agent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4-5'),
  tools,
  instructions: `${instructions}
Current user and memory owner: ${userId}
Current session: ${sessionId}
Current assistant actor: ${agentId}
The application does not log session events. Decide when to record this conversation
using start_session or add_session_event. Start a new session with the user's
message, then use add_session_event for subsequent USER and ASSISTANT events.`,
  stopWhen: isStepCount(8),
});

const result = await agent.generate({
  prompt: 'Remember that I prefer TypeScript examples.',
});
console.log(result.finalStep.text);
```

Instructions guide the model's tool choices; they do not guarantee that every message or the final reply is stored.
Saving a long-term fact with `create_memories` is separate from recording conversation events.
This approach does not automatically load conversation history into model context.

### Automatic session recording with hooks

Use toolset `onStart` and `onEnd` helpers to record the current user message and the final assistant reply independently of the model's tool choices.
Keep session-write tools out of `activeTools` to avoid duplicate recording.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemory, instructions } from 'ai-sdk-redis-agent-memory';

const userId = 'user-123';
const sessionId = 'conversation-456';
const agentId = 'assistant-1';
const memory = createRedisAgentMemory({
  serverUrl: process.env.AGENT_MEMORY_URL,
  storeId: process.env.AGENT_MEMORY_STORE_ID,
  apiKey: process.env.AGENT_MEMORY_API_KEY,
});
const tools = memory.tools({ scope: { userId, sessionId } });

const agent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4-5'),
  tools,
  activeTools: [
    'get_memory_context', 'get_session_memory',
    'create_memories', 'search_memories', 'update_memory',
  ],
  instructions: `${instructions}
Current user and memory owner: ${userId}
Current session: ${sessionId}
Current assistant actor: ${agentId}
The application records user input before generation and the final reply afterward.
Do not write session events. Use get_session_memory to read saved messages.`,
  stopWhen: isStepCount(8),
  onStart: tools.createSessionEventHook({
    role: 'USER',
    actorId: userId,
    onError: error => console.error('USER session save failed:', error.message),
  }),
  onEnd: tools.createSessionEventHook({
    role: 'ASSISTANT',
    actorId: agentId,
    onError: error => console.error('ASSISTANT session save failed:', error.message),
  }),
});
```

The USER write is awaited before the model starts, and the ASSISTANT hook records nonempty final text in `onEnd`.
See [Recording session events](#recording-session-events) for input requirements, observers, and failure behavior.

## Combining tools

`memory.tools()` returns an AI SDK `ToolSet`.
Its enumerable properties are exclusively tools; credentials and the SDK client remain in closures.

```ts
import { createRedisAgentMemory } from 'ai-sdk-redis-agent-memory';

const memory = createRedisAgentMemory({ serverUrl, storeId, apiKey });
const memoryTools = memory.tools({ scope: { userId } });
const tools = {
  search_memories: memoryTools.search_memories!,
  get_memory: memoryTools.get_memory!,
};
```

This is a server-side package.
Never put the Redis Agent Memory API keys in a frontend bundle.

## Reusing tools across conversations

Create a toolset for each trusted request scope.
Factory-level scope is only an overridable default: it is not an authorization ceiling.
Supplying a call-level scope replaces the **entire** factory scope rather than merging fields, so a session or namespace from another request cannot be inherited accidentally.
Omitting `scope`, or passing `scope: undefined`, uses the factory default.

```ts
const memory = createRedisAgentMemory({
  serverUrl,
  storeId,
  apiKey,
  scope: { userId: 'default-user', sessionId: 'default-session' },
});

const first = memory.tools(); // uses the complete factory scope
const second = memory.tools({
  scope: { userId: 'user-42', sessionId: 'conversation-2' },
}); // replaces it completely
```

Factory defaults and per-call overrides must come from trusted, authenticated application state.
They do not establish the caller's identity or replace application authorization.

A returned toolset retains the non-enumerable `withContext(scope)` helper for **narrowing that toolset's already resolved scope**, plus `createSessionEventHook(options)`.
`withContext` shares the client, does not mutate either toolset, fills only missing fields, and rejects conflicting fixed values.
This is intentionally different from the whole-scope replacement used by `memory.tools({ scope })`:

```ts
const userTools = memory.tools({ scope: { userId: 'user-42' } });
const conversationTools = userTools.withContext({ sessionId: 'conversation-1' });
```

Scope remains optional for tools.
An unscoped toolset retains its existing unscoped behavior.
Helpers are omitted from enumeration and object spread.

## Recording session events

Call `createSessionEventHook(options)` on a scoped toolset and pass the returned callback to the matching lifecycle hook: `role: 'USER'` goes on `onStart`, and `role: 'ASSISTANT'` goes on `onEnd`.
Each callback records one event using the same ownership and namespace checks as the session tools.
The [hook example above](#automatic-session-recording-with-hooks) shows both callbacks.

`userId` and `sessionId` must be fixed in the toolset's resolved scope before creating the hook, through `memory.tools({ scope })` or the returned toolset's `withContext(scope)` narrowing helper.
The hook captures that scope.
Supply `actorId` for each hook; the USER actor must equal scoped `userId`, and the ASSISTANT actor identifies your agent.
Like `withContext`, the helper is non-enumerable, so it is not advertised to the model or copied by object spread.

The USER hook reads the `onStart` input messages.
The final message must have role `user`, with either a content string or text parts.
Text parts remain separate event content items; images, files, and other non-text parts are ignored.
A user message without nonempty text fails validation.
The ASSISTANT hook reads `finalStep.text` and skips an empty reply.
Each hook validates its event before writing.
No `include.requestMessages` setting is needed.
Earlier history, intermediate steps, tool calls, and tool results are not recorded.

The USER write is awaited before the model starts, so memory tools can read that message during generation.
It remains saved if generation later fails.
The ASSISTANT event is recorded only when AI SDK invokes `onEnd` with nonempty final
text.

Hook options are:

| Option | Behavior |
| --- | --- |
| `role` | Required: `'USER'` for `onStart`, or `'ASSISTANT'` for `onEnd` |
| `actorId` | Required author ID; must match scoped `userId` for USER events |
| `onError(error, context)` | Required handler for validation or write failures; receives a sanitized `RedisAgentMemoryToolError` |
| `onEventStart(info)` | Optional observer called before each append attempt |
| `onEventSaved(info)` | Optional observer called after each confirmed append |

Observer `info` has type `SessionHookEvent` and contains `sessionId`, `role`, and `actorId`.
Error `context` contains those fields plus `userId` and `phase` (`'validation'` or `'write'`).
Callbacks may be asynchronous and are awaited; their exceptions, including exceptions from `onError`, are ignored.
Observer errors do not interrupt recording.
Hook writes do not trigger the AI SDK's `onToolExecutionStart` or `onToolExecutionEnd` callbacks; use the event observers for session logging.

The two hooks run independently.
A USER save failure does not stop generation or prevent the ASSISTANT hook from running.
A failed write may have committed without confirmation, so the assistant event may still be appended afterward.
Ownership checks still prevent an ASSISTANT event from starting a new user-owned session.
Writes are not atomic, retried, or deduplicated; verify uncertain outcomes before retrying and register each hook only once per generation.
AI SDK ignores lifecycle callback exceptions, so report failures through `onError`.
To require persistence before proceeding with generation or returning a reply, use the official SDK in the application workflow.

## Configuration

The configuration is documented in the project's [README.md](README.md#configuration).

## Tool reference

All parameter names are camelCase.
IDs remain visible to the model; fixed scopes cannot be overridden. 
The three deletion tools below are exposed only when `options.allowDeletes` is `true`.

| Tool | Parameters and result |
| --- | --- |
| `get_memory_context` | `{}` → configured IDs and identity rules, no secrets |
| `start_session` | `{actorId, text, sessionId?, namespace?, namespaceRef?}` → `{event}`; omit sessionId to have it generated |
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

`sessionId` is required for retrieval/deletion unless fixed in the scope.
`role` is `USER`, `ASSISTANT`, or `SYSTEM`. `createdAt` accepts an ISO 8601 string with timezone and defaults to the current time.
Session/owner IDs follow the server's 1–64 alphanumeric-or-hyphen convention; actor IDs accept 1–255 characters.

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

The wrapper generates a UUID v4 for each create record.
The agent does not supply an `id`.
The returned `memoryIds` array lists all generated IDs in input order, including any failed records; `created` contains successful IDs and `errors` contains per-ID failures.
Keep successful IDs for later retrieval, updates, and deletion.

Each `create_memories` invocation generates fresh IDs.
If a request times out or its outcome is uncertain, search for the memories before retrying to avoid duplicates.
Retry only records confirmed to have failed.

Bulk create/delete accepts 1–100 records/IDs and preserves the server's per-record errors.
Text accepts 1–50,000 characters; topics accept up to 50 tags.
Updates support `text`, `memoryType`, `topics`, `ownerId`, `sessionId`, and namespace placement.
An empty `sessionId` or legacy `namespace` clears it when not fixed by scope. Updating custom extraction-worker fields is deliberately outside the agent toolset; use the official SDK's worker endpoint for that workflow.

Search filters support `ownerId`, `sessionId`, legacy `namespace`, `topics`, and `memoryType` with exactly one of `{eq}`, `{ne}`, `{in: [...]}`, or `{all: [...]}`.
 `namespaceRef` supports `{eq}` or `{in}`. Use `unnamespaced` without namespace selectors. Date comparisons accept ISO strings:

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

Attribute filters accept exactly one of `{string}`, `{number}`, `{boolean}`, or `{list: string[]}` per field.
Omit `text` to list/filter without a semantic query.
Pagination uses the returned opaque `nextPageToken` with the same search parameters.

## Identity and scope behavior

`scope.userId` identifies the application user.
The tools use that identity in role-specific fields: `ownerId` for the user's memories, sessions, and PERSONAL namespaces, and `actorId` for their USER events.
Memory creation supplies `ownerId` automatically from `scope.userId`; session tools and `createSessionEventHook` require an explicit `actorId`.

Append `instructions` to your agent's instructions and supply current user/agent/session IDs in trusted application context.
A USER event uses the human user's ID as `actorId`; an ASSISTANT event uses the agent's ID.
The first event establishes immutable session ownership, so initialize user-owned sessions with the user's message.
With `scope.userId` set, the wrapper requires a new session to start with a USER event whose `actorId` matches that user ID.

The host must retain session IDs between requests.
An agent generating a session ID does not itself make that ID persistent across future model calls.
In the tools approach, persist IDs and conversation history in application storage and reuse them on later requests.
The automatic-memory model can restore available Redis Agent Memory session history when given the same session ID.

`scope.sessionId` restricts session operations but **does not filter long-term recall by session**, allowing recall from earlier conversations.
To limit long-term recall to one conversation, pass an explicit `filter.sessionId`.

User/namespace-scoped searches require `filterOp: 'all'`; an OR filter could bypass a fixed owner predicate and is rejected.
Direct-ID reads, updates, and deletes check existing ownership/placement before returning or mutating a resource.
User-scoped resource placements require a PERSONAL namespace owned by that user.
A legacy namespace label is a grouping value and has no resource ownership to inspect.

With a fixed session, `list_sessions` returns only that session.
With a namespace scope and no fixed session it rejects listing, because Redis Agent Memory has no namespace filter for this endpoint; use known IDs.
Unscoped store-wide listing requires explicit `includeAll: true`.

Resolved scopes provide application guardrails and use preflight reads.
Factory scope is only a replaceable default, not an authorization ceiling.
Neither is a substitute for authentication, store-level permissions, or protection against concurrent ownership changes made by other clients.

## Optional namespace tools

Set `namespaceTools: true` on `createRedisAgentMemory(...)` to add:

| Tool | Parameters |
| --- | --- |
| `list_namespaces` | `{parentId?, scope?, ownerId?, limit?, pageToken?}` |
| `get_namespace` | `{namespaceId}` |
| `create_namespace` | `{name?, path?, scope?, parentId?, ownerId?}` |
| `update_namespace` | `{namespaceId, name?, state?: 'ARCHIVED'}` |
| `move_memories` | `{memoryIds, namespaceId}` |
| `delete_namespace` | `{namespaceId}`; omitted when deletes are disabled |

Create roots with name/scope, children with name/parentId, or a hierarchy with path/scope.
Namespace scopes are `PERSONAL` and `SHARED`; PERSONAL roots require an owner.
User-scoped tools restrict access to that user's personal namespaces, including child namespaces inheriting root ownership.
A fixed namespace scope prevents creation or moving memories outside that namespace.
Legacy namespace scopes cannot enable resource administration tools.
Archive and delete operations follow the server's rules; deletion is for empty leaf namespaces.

## Failures and cancellation

Tool execution throws `RedisAgentMemoryToolError` with a safe `code`, message, and optional HTTP `statusCode`.
Upstream headers, bodies, and API keys are not passed into model context.
Cancellation is surfaced as `AbortError`.
Bulk results retain partial errors so the agent can identify individual failures.
An uncertain memory creation or session append can already have committed: reconcile its outcome before retrying.

Automatic summary/promotion behavior belongs to the Redis Agent Memory store configuration.
Deleting session history does not cascade to promoted long-term memories.
The package has no LLM dependency of its own and does not configure store promotion workers, store administration, or custom extraction workers.
