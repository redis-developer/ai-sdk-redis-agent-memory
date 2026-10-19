# Redis Agent Memory for Vercel's AI SDK

This integration provides short-term and long-term memory tools to agents developed with Vercel's [AI SDK](https://ai-sdk.dev/).

It also provides a **memory provider** that wraps a configured model to restore
session history, recall personal long-term memories, and record conversational
text automatically. Choose the integration that fits your application; the tools
API remains supported and works independently of the provider.

## Choose an approach

| | Tools | Provider |
| --- | --- | --- |
| Entry point | `ai-sdk-redis-agent-memory` | `ai-sdk-redis-agent-memory/provider` |
| Setup | `createRedisAgentMemoryTools(...)` or `new RedisAgentMemory(...)` | `createRedisAgentMemoryProvider({ model, ...connection })` |
| Agent integration | Pass the tool map as `tools` alongside your model | Pass `memory.forRequest(options)` as the request's `model` |
| Recall and history | The model chooses memory tools; the application manages its input history | By default, restores the scoped session and injects recalled personal memories before inference |
| Session recording | Model-selected session tools, or optional application lifecycle hooks | Automatic USER recording and successful text-bearing assistant steps by default in Iris-managed mode |
| Choose when | You want explicit memory operations, selective tools, or model-directed memory management | You want automatic context and session continuity without model-selected memory tools |
| Quick start | [Agent-managed recording](#agent-managed-session-recording-no-hooks) or [recording hooks](#automatic-session-recording-with-hooks) | [Automatic context and recording](#provider-automatic-context-and-recording) |

Hooks are an optional recording mode of the tools approach, not a prerequisite
for either integration. Both approaches use Iris and application-owned scope.
They may coexist, but do not enable provider recording and session-write tools or
recording hooks for the same interaction: that can duplicate events.

## Installation

Requires **Node.js 22+**, **AI SDK 7.0.114+ (7.x)**, and **Zod 4.1.8+ (4.x)**. This is a server-side, ESM-only package with TypeScript declarations.

After the first npm release:

```sh
npm install ai-sdk-redis-agent-memory ai@^7.0.114 zod@^4.1.8
```

Before that release, [build and install a local tarball](#development). Provision a Redis Agent Memory store in [Redis Cloud](https://cloud.redis.io/#/agent-memory), then set `AGENT_MEMORY_API_KEY` and `AGENT_MEMORY_STORE_ID` in your server environment. Set `AGENT_MEMORY_URL` if your store uses a different endpoint.

## Quick start

These examples use Anthropic directly; install its provider with `npm install @ai-sdk/anthropic@^4` and set `ANTHROPIC_API_KEY`. Other AI SDK 7-compatible model providers work with the same toolset.

The tools examples come first; the [provider example](#provider-automatic-context-and-recording)
uses the same Anthropic model, configured once in a reusable memory factory.

### Agent-managed session recording (no hooks)

Give the agent the memory tools and let it decide when to record session events
or save long-term facts. This example has no application-managed session logging.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemoryTools, instructions } from 'ai-sdk-redis-agent-memory';

// Your application supplies these from authenticated user/conversation state.
const userId = 'user-123';
const sessionId = 'conversation-456';
const agentId = 'assistant-1';

const tools = createRedisAgentMemoryTools(
  // Defaults to AGENT_MEMORY_URL or https://gcp-us-east4.memory.redis.io.
  process.env.AGENT_MEMORY_URL,
  process.env.AGENT_MEMORY_STORE_ID,
  process.env.AGENT_MEMORY_API_KEY,
  { userId, sessionId },
);

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
`create_memories` is separate from recording conversation events. This toolset
does not automatically load conversation history into the model context.

For automatic restoration and context injection instead of model-selected memory
tools, use the [provider approach](#provider-automatic-context-and-recording) below.

### Automatic session recording with hooks

Use the same factory with `onStart` and `onEnd` to record the current user message
and the final assistant reply independently of the model's tool choices. Keep
session-write tools out of `activeTools` to avoid duplicate recording; the agent
can still decide when to save and retrieve long-term memories.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemoryTools, instructions } from 'ai-sdk-redis-agent-memory';

// Your application supplies these from authenticated user/conversation state.
const userId = 'user-123';
const sessionId = 'conversation-456';
const agentId = 'assistant-1';

const tools = createRedisAgentMemoryTools(
  process.env.AGENT_MEMORY_URL,
  process.env.AGENT_MEMORY_STORE_ID,
  process.env.AGENT_MEMORY_API_KEY,
  { userId, sessionId },
);

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

const result = await agent.generate({
  prompt: 'Remember that I prefer TypeScript examples.',
});
console.log(result.finalStep.text);
```

The USER write is awaited before the model starts, and the ASSISTANT hook records
nonempty final text in `onEnd`. The hooks run independently and report save
failures through `onError`. See [Recording session events](#recording-session-events)
for input requirements, observers, and failure behavior.

### Provider: automatic context and recording

Configure a model and Iris connection once with the independent `./provider`
subpath, then create a request-scoped model with `memory.forRequest()`. The
wrapper restores the Iris session, recalls personal long-term memories, injects a
bounded untrusted context block, and records the current user input plus every
successful text-bearing raw assistant step. It does not expose memory tools to the
model, so recall and session recording do not depend on a model deciding to call one.
When context is nonempty, the wrapper prepends the fixed outer notice
`IRIS MEMORY CONTEXT MAY BE STALE.\n`. Its 34 UTF-16 units are fixed framing
outside the independently configured session and long-term-memory character budgets.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemoryProvider } from 'ai-sdk-redis-agent-memory/provider';

const memory = createRedisAgentMemoryProvider({
  serverUrl: process.env.AGENT_MEMORY_URL,
  storeId: process.env.AGENT_MEMORY_STORE_ID,
  apiKey: process.env.AGENT_MEMORY_API_KEY,
  model: anthropic('claude-sonnet-4-5'),
});

// Inside each application request. Derive IDs from authenticated state.
async function reply(userId: string, sessionId: string, prompt: string) {
  const agent = new ToolLoopAgent({
    model: memory.forRequest({
      scope: { userId, sessionId },
      assistantId: 'assistant',
    }),
    stopWhen: isStepCount(8),
  });
  return agent.generate({ prompt });
}
```

The factory shares the configured model and Iris client across requests. Each
`forRequest()` result owns its scope, recall/restoration snapshot, USER-write
attempt, recording budget, and concurrency/cancellation state. Reuse that result
for steps and retries **within one request**, never across independent requests.
Factory and request-model construction make no network calls. Overlapping calls
on the same request model are rejected; separate request models may run
concurrently for distinct sessions. Do not pass `model: memory` to a singleton
agent: automatic agent-level request lifecycle integration is not supported.
This unreleased API replaces `wrap(model, options)`; there is no `wrap()` alias.

The default `historyMode: 'iris'` owns conversation history: it restores the
session and defaults `recording` to `true`, giving a fresh request model for the same
session the ability to pick up where the previous request stopped. The current
USER event is written once before inference; every successful raw model step with
generated text is written afterward, including intermediate tool-loop steps, not
only the final answer. Only text is restored and recorded; image-only input,
reasoning, tool arguments/results, binary data, and system events are omitted.
Iris may use recorded session activity for its configured
background long-term-memory extraction. Consent, PII handling, retention, and
extraction policy remain Iris/application configuration concerns; this package
does not implement another extraction pipeline.

Use application-managed mode when your application already supplies complete
history. It does not restore session events and defaults recording off, but still
recalls long-term memory:

```ts
const model = memory.forRequest({
  scope: { userId, sessionId },
  historyMode: 'application',
  recording: false,
});
```

Set `includeMemoryProvenance: true` to add a sanitized
`providerMetadata.redisAgentMemory.memories` list for memories actually included
in the prompt. Entries contain only `id`, `memoryType`, `createdAt`, and
`updatedAt`. Provenance is off by default. If the base model already owns the
`redisAgentMemory` metadata key, its metadata is preserved unchanged and wrapper
provenance is omitted.

The wrapper is best effort, not an exactly-once delivery system. Iris 0.3.1 has
no conditional session creation or append idempotency key; a timed-out POST may
have committed. Use collision-resistant session IDs bound to the authenticated
user in application-owned state, and globally serialize requests by the exact
session ID—even if callers claim different users. A postflight check can stop
later inference or writes, but cannot undo an already accepted cross-principal
USER event. Never combine automatic wrapper recording with session lifecycle
hooks or model-callable session-write tools for the same request, or events can
be duplicated.

For streaming, recording follows raw provider completion: a finish part followed
by normal source close. The wrapper holds the terminal finish briefly for the
bounded save, but nonterminal parts pass through as produced. This does not prove
that a downstream client consumed the stream. Cancellation or transport failure
before raw completion prevents the assistant write where possible; an accepted
POST cannot be rolled back. Memory read/write failures are reported only through
the optional content-free `onDiagnostic` callback and do not overwrite successful
model output. Scope violations remain hard failures before inference.

## Runnable demo

See [demo/](https://github.com/redis-developer/ai-sdk-redis-agent-memory/tree/main/demo)
for a minimal terminal chat using the local package. Save a preference, start a
new conversation with `/new`, and watch the agent recall it from Redis. Setup
instructions are in the demo README. The demo is excluded from npm releases.

## Combining tools

`createRedisAgentMemoryTools(serverUrl?, storeId?, apiKey?, scope?, options?)` returns a tool map compatible with the AI SDK `ToolSet`, useful for spreading or selectively including tools. Its own enumerable properties are exclusively tools; API credentials and the SDK client stay in closures.

```ts
import { createRedisAgentMemoryTools } from 'ai-sdk-redis-agent-memory';
const memory = createRedisAgentMemoryTools();
const tools = { search_memories: memory.search_memories!, get_memory: memory.get_memory! };
```

This is a server-side package. Never put the Iris API key in a frontend bundle.

## Reusing memory across conversations

Call `withContext(scope)` on the factory result to get independent tools for a
conversation. Each result shares the original SDK client and configuration,
and captures a copy of its scope.

```ts
const memory = createRedisAgentMemoryTools(serverUrl, storeId, apiKey, {
  userId: 'user-42',
});

const agent = new ToolLoopAgent({
  model,
  tools: memory.withContext({ sessionId: 'conversation-1' }),
});
const anotherAgent = new ToolLoopAgent({
  model,
  tools: memory.withContext({ sessionId: 'conversation-2' }),
});
```

`withContext` leaves the original toolset and previously derived toolsets
unchanged, so conversations can run concurrently. It accepts the same `userId`,
`sessionId`, `namespaceId`, and legacy `namespace` fields as construction-time
scope. Defined values fill missing fields; omitted or `undefined` fields retain
their existing values. Conflicting fixed values are rejected, including values
bound by an earlier `withContext` call. To serve multiple users, leave `userId`
unset on the base toolset and provide it on each derived toolset. For multiple
conversations, leave `sessionId` unset on the base.

Scope remains optional when creating the toolset. A toolset with no scope
retains its existing unscoped behavior; omitting scope does not defer execution
until `withContext` is called. The helper is non-enumerable, so it is never
advertised to the model as a tool and is omitted when spreading the toolset.

## Recording session events

Call `createSessionEventHook(options)` on a scoped toolset and pass the returned
callback to the matching lifecycle hook: `role: 'USER'` goes on `onStart`, and
`role: 'ASSISTANT'` goes on `onEnd`. Each callback records one event using the
same ownership and namespace checks as the session tools. The
[hook example above](#automatic-session-recording-with-hooks) shows both callbacks
on a toolset created by the factory.

`userId` and `sessionId` must be fixed in the toolset's scope before creating the
hook, through the factory or `withContext`. The hook captures that scope.
Supply `actorId` for each hook; the USER actor must equal the scoped
`userId`, and the ASSISTANT actor identifies your agent. Like `withContext`, the
helper is non-enumerable, so it is not advertised to the model or copied by
object spread.

The USER hook reads the `onStart` input messages. The final message must have
role `user`, with either a content string or text parts. Text parts remain
separate event content items; images, files, and other non-text parts are
ignored. A user message without nonempty text fails validation. The ASSISTANT
hook reads `finalStep.text` and skips an empty reply. Each hook validates its
event before writing. No `include.requestMessages` setting is needed. Earlier
history, intermediate steps, tool calls, and tool results are not recorded.

The USER write is awaited before the model starts, so memory tools can read
that message during generation. It remains saved if generation later fails.
The ASSISTANT event is recorded only when the SDK invokes `onEnd` with nonempty
final text.

Hook options are:

| Option | Behavior |
| --- | --- |
| `role` | Required: `'USER'` for `onStart`, or `'ASSISTANT'` for `onEnd` |
| `actorId` | Required author ID; must match scoped `userId` for USER events |
| `onError(error, context)` | Required handler for validation or write failures; receives a sanitized `RedisAgentMemoryToolError` |
| `onEventStart(info)` | Optional observer called before each append attempt |
| `onEventSaved(info)` | Optional observer called after each confirmed append |

Observer `info` has type `SessionHookEvent` and contains `sessionId`, `role`, and
`actorId`. Error `context` contains those same fields plus `userId` and `phase`
(`'validation'` or `'write'`).
Callbacks may be asynchronous and are awaited; their exceptions, including
exceptions from `onError`, are ignored. Observer errors do not interrupt
recording. Hook writes do not trigger the AI SDK's `onToolExecutionStart` or
`onToolExecutionEnd` callbacks; use the event observers for session logging.

The two hooks run independently. A USER save failure does not stop generation
or prevent the ASSISTANT hook from running. A failed write may have committed
without confirmation, so the assistant event may still be appended afterward.
Ownership checks still prevent an ASSISTANT event from starting a new
user-owned session. Writes are not atomic, retried, or deduplicated; verify
uncertain outcomes before retrying and register each hook only once per
generation. AI SDK ignores lifecycle callback exceptions, so report failures
through `onError`. To require persistence before proceeding with generation or
returning a reply, use the official SDK in your application workflow.

## Configuration

This section covers the **tools** approach. The **provider** accepts an options
object, not positional arguments; see the [provider example](#provider-automatic-context-and-recording).

The factory accepts these positional arguments:

```ts
createRedisAgentMemoryTools(serverUrl, storeId, apiKey, scope, options);
```

The `RedisAgentMemory` class constructor remains available with the same arguments
and helpers as the factory result.

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

Configuration is copied at construction. Create a scoped toolset for each authenticated request/conversation; do not mutate a shared instance's scope. During tool execution, the AI SDK `abortSignal` is forwarded to Iris requests. The session event hook has no generation abort signal and uses the configured HTTP timeout. SDK defaults disable automatic retries, avoiding duplicate session appends after uncertain network outcomes.

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
