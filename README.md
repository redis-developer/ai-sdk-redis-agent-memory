# Redis Agent Memory for Vercel's AI SDK

This integration supports two complementary ways to add Redis Agent Memory to
agents built with Vercel's [AI SDK](https://ai-sdk.dev/): ordinary memory tools,
and an automatic-memory model wrapper that restores context and records sessions.
Both are created by the same server-side `createRedisAgentMemory(...)` factory.

## Choose an approach

| | Tools | Automatic-memory model |
| --- | --- | --- |
| Entry point | `ai-sdk-redis-agent-memory` | `ai-sdk-redis-agent-memory` |
| Setup | `memory.tools({ scope? })` | `memory.model({ scope?, model?, ...options })` |
| Agent integration | Pass the returned tool map as `tools` alongside your model | Pass a fresh returned model as the request's `model` |
| Recall and history | The model chooses memory tools; the application manages input history | Restores the scoped session and injects recalled personal memories before inference by default |
| Session recording | Model-selected session tools, or optional application lifecycle hooks | Automatic USER recording and successful text-bearing assistant steps by default in Iris-managed mode |
| Choose when | You want explicit operations, selective tools, or model-directed memory management | You want automatic context and continuity without model-selected memory tools |
| Quick start | [Agent-managed recording](#agent-managed-session-recording-no-hooks) or [recording hooks](#automatic-session-recording-with-hooks) | [Automatic context and recording](#automatic-memory-model-context-and-recording) |

Hooks are an optional recording mode of the tools approach, not a prerequisite
for either integration. The approaches may coexist, but do not enable automatic
model recording and session-write tools or recording hooks for the same
interaction: that can duplicate events.

## Installation

Requires **Node.js 22+**, **AI SDK 7.0.114+ (7.x)**, and **Zod 4.1.8+ (4.x)**. This is a server-side, ESM-only package with TypeScript declarations.

After the first npm release:

```sh
npm install ai-sdk-redis-agent-memory ai@^7.0.114 zod@^4.1.8
```

Before that release, [build and install a local tarball](#development). Provision a Redis Agent Memory store in [Redis Cloud](https://cloud.redis.io/#/agent-memory), then set `AGENT_MEMORY_API_KEY` and `AGENT_MEMORY_STORE_ID` in your server environment. Set `AGENT_MEMORY_URL` if your store uses a different endpoint.

## Quick start

These examples use Anthropic directly; install its provider with `npm install @ai-sdk/anthropic@^4` and set `ANTHROPIC_API_KEY`. Other AI SDK 7-compatible configured models work with the same APIs. Model-name strings are not accepted.

### Agent-managed session recording (no hooks)

Give the agent the memory tools and let it decide when to record session events
or save long-term facts. Tools do not require a configured model.

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

Instructions guide the model's tool choices; they do not guarantee that every
message or the final reply is stored. Saving a long-term fact with
`create_memories` is separate from recording conversation events. This approach
does not automatically load conversation history into model context.

### Automatic session recording with hooks

Use toolset `onStart` and `onEnd` helpers to record the current user message and
the final assistant reply independently of the model's tool choices. Keep
session-write tools out of `activeTools` to avoid duplicate recording.

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

The USER write is awaited before the model starts, and the ASSISTANT hook records
nonempty final text in `onEnd`. See [Recording session events](#recording-session-events)
for input requirements, observers, and failure behavior.

### Automatic-memory model: context and recording

Configure the Iris connection and, optionally, a default model once. Create a
fresh request-scoped model with `memory.model(...)` inside every application
request. The wrapper restores the Iris session, recalls personal long-term
memories, injects a bounded untrusted context block, and records the current user
input plus every successful text-bearing raw assistant step. It exposes no memory
tools to the model. When context is nonempty, the wrapper prepends
`IRIS MEMORY CONTEXT MAY BE STALE.\n`; that fixed 34-UTF-16-unit framing sits
outside the separate session and long-term-memory character budgets.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemory } from 'ai-sdk-redis-agent-memory';

const memory = createRedisAgentMemory({
  serverUrl: process.env.AGENT_MEMORY_URL,
  storeId: process.env.AGENT_MEMORY_STORE_ID,
  apiKey: process.env.AGENT_MEMORY_API_KEY,
  model: anthropic('claude-sonnet-4-5'),
});

async function reply(userId: string, sessionId: string, prompt: string) {
  const agent = new ToolLoopAgent({
    model: memory.model({
      scope: { userId, sessionId },
      assistantId: 'assistant',
    }),
    stopWhen: isStepCount(8),
  });
  return agent.generate({ prompt });
}
```

A default model is optional because `memory.tools()` is independent. If the
factory has no model, provide one to each `memory.model({ model, ... })` call.
Missing, string-valued, or otherwise invalid models fail synchronously before
network calls.

The factory shares its Iris client and configured default model. Each
`memory.model()` result owns its scope, recall/restoration snapshot, USER-write
attempt, recording budget, sequencing, and concurrency/cancellation state. Reuse
that result for steps and retries **within one application request**, never across
independent requests. Factory, tool, and model construction make no network
calls. Overlapping calls on one request model are rejected; independent request
models may run concurrently. Do not pass `model: memory` to a singleton agent;
automatic agent-level lifecycle integration is not supported.

The default `historyMode: 'iris'` restores the session and defaults `recording`
to `true`. The current USER event is written once before inference; every
successful raw model step with generated text is written afterward, including
intermediate tool-loop steps. Only text is restored and recorded; image-only
input, reasoning, tool arguments/results, binary data, and system events are
omitted. Iris may extract long-term memories asynchronously from recorded events.
Consent, PII handling, retention, and extraction policy remain application and
Iris configuration concerns.

Application-managed mode does not restore session events and defaults recording
off, but still recalls long-term memory:

```ts
const model = memory.model({
  scope: { userId, sessionId },
  historyMode: 'application',
  recording: false,
});
```

Set `includeMemoryProvenance: true` to add a sanitized
`providerMetadata.redisAgentMemory.memories` list for memories actually included
in the prompt. Entries contain only `id`, `memoryType`, `createdAt`, and
`updatedAt`. Provenance is off by default. Existing underlying metadata is
preserved; if it already owns `redisAgentMemory`, wrapper provenance is omitted.

The wrapper is best effort, not exactly once. Iris has no conditional session
creation or append idempotency key; a timed-out POST may have committed. Use
collision-resistant session IDs bound to authenticated state and serialize
requests by exact session ID. Never combine automatic recording with session
hooks or model-callable session-write tools for the same interaction.

For streaming, nonterminal parts pass through as produced. Recording follows raw
provider finish plus normal source close, and the terminal finish is held only
for the bounded save. Cancellation or transport failure before raw completion
prevents the assistant write where possible; an accepted POST cannot be rolled
back. Memory failures are exposed through the optional content-free
`onDiagnostic` callback and do not replace successful model output. Scope
violations remain hard failures.

## Runnable demos

- [`demo/tools/`](demo/tools/) demonstrates the explicit tools and recording-hook approach.

The tools demo has independent installation, test, and startup instructions and
is excluded from npm releases. The automatic-memory demo is introduced by
stacked [PR #3](https://github.com/redis-developer/ai-sdk-redis-agent-memory/pull/3).

## Combining tools

`memory.tools()` returns an AI SDK `ToolSet`. Its enumerable properties are
exclusively tools; credentials and the SDK client remain in closures.

```ts
import { createRedisAgentMemory } from 'ai-sdk-redis-agent-memory';

const memory = createRedisAgentMemory({ serverUrl, storeId, apiKey });
const memoryTools = memory.tools({ scope: { userId } });
const tools = {
  search_memories: memoryTools.search_memories!,
  get_memory: memoryTools.get_memory!,
};
```

This is a server-side package. Never put the Iris API key in a frontend bundle.

## Reusing tools across conversations

Create a toolset for each trusted request scope. Factory-level scope is only an
overridable default: it is not an authorization ceiling. Supplying a call-level
scope replaces the **entire** factory scope rather than merging fields, so a
session or namespace from another request cannot be inherited accidentally.
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

Factory defaults and per-call overrides must come from trusted, authenticated
application state. They do not establish the caller's identity or replace
application authorization.

A returned toolset retains the non-enumerable `withContext(scope)` helper for
**narrowing that toolset's already resolved scope**, plus
`createSessionEventHook(options)`. `withContext` shares the client, does not
mutate either toolset, fills only missing fields, and rejects conflicting fixed
values. This is intentionally different from the whole-scope replacement used by
`memory.tools({ scope })`:

```ts
const userTools = memory.tools({ scope: { userId: 'user-42' } });
const conversationTools = userTools.withContext({ sessionId: 'conversation-1' });
```

Scope remains optional for tools. An unscoped toolset retains its existing
unscoped behavior. Helpers are omitted from enumeration and object spread.

## Recording session events

Call `createSessionEventHook(options)` on a scoped toolset and pass the returned
callback to the matching lifecycle hook: `role: 'USER'` goes on `onStart`, and
`role: 'ASSISTANT'` goes on `onEnd`. Each callback records one event using the
same ownership and namespace checks as the session tools. The
[hook example above](#automatic-session-recording-with-hooks) shows both callbacks.

`userId` and `sessionId` must be fixed in the toolset's resolved scope before
creating the hook, through `memory.tools({ scope })` or the returned toolset's
`withContext(scope)` narrowing helper. The hook captures that scope. Supply
`actorId` for each hook; the USER actor must equal scoped `userId`, and the
ASSISTANT actor identifies your agent. Like `withContext`, the helper is
non-enumerable, so it is not advertised to the model or copied by object spread.

The USER hook reads the `onStart` input messages. The final message must have
role `user`, with either a content string or text parts. Text parts remain
separate event content items; images, files, and other non-text parts are
ignored. A user message without nonempty text fails validation. The ASSISTANT
hook reads `finalStep.text` and skips an empty reply. Each hook validates its
event before writing. No `include.requestMessages` setting is needed. Earlier
history, intermediate steps, tool calls, and tool results are not recorded.

The USER write is awaited before the model starts, so memory tools can read that
message during generation. It remains saved if generation later fails. The
ASSISTANT event is recorded only when AI SDK invokes `onEnd` with nonempty final
text.

Hook options are:

| Option | Behavior |
| --- | --- |
| `role` | Required: `'USER'` for `onStart`, or `'ASSISTANT'` for `onEnd` |
| `actorId` | Required author ID; must match scoped `userId` for USER events |
| `onError(error, context)` | Required handler for validation or write failures; receives a sanitized `RedisAgentMemoryToolError` |
| `onEventStart(info)` | Optional observer called before each append attempt |
| `onEventSaved(info)` | Optional observer called after each confirmed append |

Observer `info` has type `SessionHookEvent` and contains `sessionId`, `role`, and
`actorId`. Error `context` contains those fields plus `userId` and `phase`
(`'validation'` or `'write'`). Callbacks may be asynchronous and are awaited;
their exceptions, including exceptions from `onError`, are ignored. Observer
errors do not interrupt recording. Hook writes do not trigger the AI SDK's
`onToolExecutionStart` or `onToolExecutionEnd` callbacks; use the event observers
for session logging.

The two hooks run independently. A USER save failure does not stop generation or
prevent the ASSISTANT hook from running. A failed write may have committed
without confirmation, so the assistant event may still be appended afterward.
Ownership checks still prevent an ASSISTANT event from starting a new user-owned
session. Writes are not atomic, retried, or deduplicated; verify uncertain
outcomes before retrying and register each hook only once per generation. AI SDK
ignores lifecycle callback exceptions, so report failures through `onError`. To
require persistence before proceeding with generation or returning a reply, use
the official SDK in the application workflow.

## Configuration

```ts
const memory = createRedisAgentMemory({
  serverUrl,
  storeId,
  apiKey,
  scope,
  model,
  allowDeletes,
  namespaceTools,
  timeoutMs,
});
```

| Factory option | Default / behavior |
| --- | --- |
| `serverUrl` | `AGENT_MEMORY_URL`, then the production US East endpoint |
| `storeId` | `AGENT_MEMORY_STORE_ID`; required here or through the environment |
| `apiKey` | `AGENT_MEMORY_API_KEY`; required here or through the environment |
| `scope` | Optional default `{ userId?, sessionId?, namespaceId? | namespace? }` |
| `model` | Optional configured AI SDK model default; never a model-name string |
| `allowDeletes` | `false`; exposes deletion tools when true |
| `namespaceTools` | `false`; exposes namespace administration and memory moves when true |
| `timeoutMs` | `30000` per HTTP request; must be positive and finite |

Scope accepts `userId`, `sessionId`, `namespaceId`, and the legacy `namespace`
label. `namespaceId` and `namespace` are mutually exclusive. Configuration is
validated and copied at construction; later mutations of caller-owned objects do
not alter factory defaults.

`memory.tools({ scope? })` accepts only a scope override. `memory.model(...)`
accepts `scope?`, `model?`, `assistantId?`, `historyMode?`, `recording?`, `query?`,
`strictReads?`, `includeMemoryProvenance?`, `limits?`, and `onDiagnostic?`.
Omitting an override or passing `undefined` uses its factory default. A defined
scope override replaces the full default scope; a defined model override replaces
the model default. Inputs, the factory, and previously returned toolsets/models
are never mutated.

Automatic-memory models require a resolved scope with `userId`; Iris-managed
history or recording additionally requires `sessionId`, and recording requires a
valid `assistantId`. Tools preserve their prior unscoped behavior when no scope is
configured. All existing validation and ownership/namespace checks run after
default resolution.

Model limits default to 5 recalled memories, 8,000 characters of long-term
memory context, 24,000 characters of restored session context, one-second shared
read and per-write deadlines, and a 100,000-UTF-16-unit cumulative recording
budget. Override them through `limits`; diagnostics remain opt-in through
`onDiagnostic` and never include prompt, memory, or credential text.

The factory scope is trusted configuration, not an authorization ceiling. Resolve
scope and overrides from authenticated application state. During tool execution,
the AI SDK `abortSignal` is forwarded to Iris. Session hooks use the configured
HTTP timeout. SDK defaults disable automatic retries, avoiding duplicate appends
after uncertain outcomes.

## Intentional unreleased API removals

The unified root factory replaces the unreleased `RedisAgentMemory` class,
`createRedisAgentMemoryTools(...)`, `createRedisAgentMemoryProvider(...)`, the
`RedisAgentMemoryProvider` object, its `forRequest(...)` method, and the separate
`ai-sdk-redis-agent-memory/provider` public entry point. Use
`createRedisAgentMemory(...).tools(...)` or
`createRedisAgentMemory(...).model(...)`; no compatibility aliases are retained.
The earlier unreleased `wrap(...)` API also remains removed. Provider-related
option, diagnostic, limit, and provenance types are exported from the package root.

## Tool reference

All parameter names are camelCase. IDs remain visible to the model; fixed scopes cannot be overridden. The three deletion tools below are exposed only when `options.allowDeletes` is `true`.

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

`scope.userId` identifies the application user. The tools use that identity in role-specific fields: `ownerId` for the user's memories, sessions, and PERSONAL namespaces, and `actorId` for their USER events. Memory creation supplies `ownerId` automatically from `scope.userId`; session tools and `createSessionEventHook` require an explicit `actorId`.

Append `instructions` to your agent's instructions and supply current user/agent/session IDs in trusted application context. A USER event uses the human user's ID as `actorId`; an ASSISTANT event uses the agent's ID. The first event establishes immutable session ownership, so initialize user-owned sessions with the user's message. With `scope.userId` set, the wrapper requires a new session to start with a USER event whose `actorId` matches that user ID.

The host must retain session IDs between requests. An agent generating a session
ID does not itself make that ID persistent across future model calls. In the tools
approach, persist IDs and conversation history in application storage and reuse
them on later requests. The automatic-memory model can restore available Iris
session history when given the same session ID.

`scope.sessionId` restricts session operations but **does not filter long-term recall by session**, allowing recall from earlier conversations. To limit long-term recall to one conversation, pass an explicit `filter.sessionId`.

User/namespace-scoped searches require `filterOp: 'all'`; an OR filter could bypass a fixed owner predicate and is rejected. Direct-ID reads, updates, and deletes check existing ownership/placement before returning or mutating a resource. User-scoped resource placements require a PERSONAL namespace owned by that user. A legacy namespace label is a grouping value and has no resource ownership to inspect.

With a fixed session, `list_sessions` returns only that session. With a namespace scope and no fixed session it rejects listing, because Iris has no namespace filter for this endpoint; use known IDs. Unscoped store-wide listing requires explicit `includeAll: true`.

Resolved scopes provide application guardrails and use preflight reads. Factory
scope is only a replaceable default, not an authorization ceiling. Neither is a
substitute for authentication, store-level permissions, or protection against
concurrent ownership changes made by other clients.

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
