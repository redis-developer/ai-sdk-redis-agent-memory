# Redis Agent Memory for Vercel's AI SDK

[Redis Agent Memory](https://redis.io/agent-memory/), a part of the [Iris suite](https://redis.io/iris/), provides a managed memory layer that gives agents intelligent short-term memory and persistent context across conversations.
It allows AI agents to combine session history with long-term memories so they can recall user preferences, retain useful facts, and pick up where they left off.

This integration supports two complementary ways to add Redis Agent Memory to agents built with Vercel's [AI SDK](https://ai-sdk.dev/): an automatic-memory model wrapper that restores context and records sessions, and ordinary memory tools.
Both are created by the same server-side `createRedisAgentMemory(...)` factory.

## Choose an approach

| | Automatic-memory model | Tools |
| --- | --- | --- |
| Entry point | `ai-sdk-redis-agent-memory` | `ai-sdk-redis-agent-memory` |
| Setup | `memory.model({ scope?, model?, ...options })` | `memory.tools({ scope? })` |
| Agent integration | Pass a fresh returned model as the request's `model` | Pass the returned tool map as `tools` alongside your model |
| Recall and history | Restores the scoped session and injects recalled personal memories before inference by default | The model chooses memory tools; the application manages input history |
| Session recording | Automatic USER recording and successful text-bearing assistant steps by default in Iris-managed mode | Model-selected session tools, or optional application lifecycle hooks |
| Choose when | You want automatic context and continuity without model-selected memory tools | You want explicit operations, selective tools, or model-directed memory management |
| Quick start | [Automatic context and recording](#automatic-memory-model) | [Agent-managed recording](TOOLS.md#agent-managed-session-recording-no-hooks) or [recording hooks](TOOLS.md#automatic-session-recording-with-hooks) |

Hooks are an optional recording mode of the tools approach, not a prerequisite for either integration.
The approaches may coexist, but do not enable automatic model recording and session-write tools or recording hooks for the same interaction: that can duplicate events.

## Installation

Requires Node.js 22+, AI SDK 7.0.114+ (7.x), and Zod 4.1.8+ (4.x).
This is a server-side, ESM-only package with TypeScript declarations.

```sh
npm install ai-sdk-redis-agent-memory
```

Provision a Redis Agent Memory store in [Redis Cloud](https://cloud.redis.io/#/agent-memory), then set `AGENT_MEMORY_API_KEY` and `AGENT_MEMORY_STORE_ID` in your server environment.
Set `AGENT_MEMORY_URL` if your store uses a different endpoint.

## Quick start

These examples use Anthropic directly; install its provider with `npm install @ai-sdk/anthropic@^4` and set `ANTHROPIC_API_KEY`.
Other AI SDK 7-compatible configured models work with the same APIs. Model-name strings are not accepted.

### Automatic-memory model

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

Configure the Redis Agent Memory connection and, optionally, a default model once.
Create a fresh request-scoped model with `memory.model(...)` inside every application request.
The wrapper restores the Iris session, recalls personal long-term memories, injects a bounded untrusted context block, and records the current user input plus every successful text-bearing raw assistant step.
It exposes no memory tools to the model.
When context is nonempty, the wrapper prepends `IRIS MEMORY CONTEXT MAY BE STALE.\n`; that fixed 34-UTF-16-unit framing sits outside the separate session and long-term-memory character budgets.

A default model is optional because `memory.tools()` is independent.
If the factory has no model, provide one to each `memory.model({ model, ... })` call.
Missing, string-valued, or otherwise invalid models fail synchronously before network calls.

The factory shares its Redis Agent Memory client and configured default model.
Each `memory.model()` result owns its scope, recall/restoration snapshot, USER-write attempt, recording budget, sequencing, and concurrency/cancellation state.
Reuse that result for steps and retries **within one application request**, never across independent requests.
Factory, tool, and model construction make no network calls.
Overlapping calls on one request model are rejected; independent request models may run concurrently.
Do not pass `model: memory` to a singleton agent; automatic agent-level lifecycle integration is not supported.

The default `historyMode: 'iris'` restores the session and defaults `recording` to `true`.
The current USER event is written once before inference; every successful raw model step with generated text is written afterward, including intermediate tool-loop steps.
Only text is restored and recorded; image-only input, reasoning, tool arguments/results, binary data, and system events are omitted.
Redis Agent Memory may extract long-term memories asynchronously from recorded events.
Consent, PII handling, retention, and extraction policy remain application and Redis Agent Memory configuration concerns.

Application-managed mode does not restore session events and defaults recording off, but still recalls long-term memory:

```ts
const model = memory.model({
  scope: { userId, sessionId },
  historyMode: 'application',
  recording: false,
});
```

Set `includeMemoryProvenance: true` to add a sanitized `providerMetadata.redisAgentMemory.memories` list for memories actually included in the prompt.
Entries contain only `id`, `memoryType`, `createdAt`, and `updatedAt`.
Provenance is off by default.
Existing underlying metadata is preserved; if it already owns `redisAgentMemory`, wrapper provenance is omitted.

The wrapper is best effort, not exactly once.
Redis Agent Memory has no conditional session creation or append idempotency key; a timed-out POST may have committed. Use collision-resistant session IDs bound to authenticated state and serialize requests by exact session ID.
Never combine automatic recording with session hooks or model-callable session-write tools for the same interaction.

For streaming, nonterminal parts pass through as produced.
Recording follows raw provider finish plus normal source close, and the terminal finish is held only for the bounded save.
Cancellation or transport failure before raw completion prevents the assistant write where possible; an accepted POST cannot be rolled back.
Memory failures are exposed through the optional content-free `onDiagnostic` callback and do not replace successful model output.
Scope violations remain hard failures.

## Runnable demos

- [`demo/provider/`](demo/provider/) demonstrates the automatic-memory model approach.
- [`demo/tools/`](demo/tools/) demonstrates the explicit tools and recording-hook approach.

Each demo has independent installation, test, and startup instructions and is excluded from npm releases.

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
| `namespaceTools` | `false`; exposes namespace administration tools when true |
| `timeoutMs` | `30000` per HTTP request; must be positive and finite |

Scope accepts `userId`, `sessionId`, `namespaceId`, and the legacy `namespace` label.
`namespaceId` and `namespace` are mutually exclusive.
Configuration is validated and copied at construction; later mutations of caller-owned objects do not alter factory defaults.

`memory.model(...)` accepts `scope?`, `model?`, `assistantId?`, `historyMode?`, `recording?`, `query?`, `strictReads?`, `includeMemoryProvenance?`, `limits?`, and `onDiagnostic?`.
`memory.tools({ scope? })` accepts only a scope override.
Omitting an override or passing `undefined` uses its factory default.
A defined scope override replaces the full default scope; a defined model override replaces the model default.
Inputs, the factory, and previously returned toolsets/models are never mutated.

Automatic-memory models require a resolved scope with `userId`; Iris-managed history or recording additionally requires `sessionId`, and recording requires a valid `assistantId`.
Tools preserve their prior unscoped behavior when no scope is configured. All existing validation and ownership/namespace checks run after default resolution.

Model limits default to 5 recalled memories, 8,000 characters of long-term memory context, 24,000 characters of restored session context, one-second shared read and per-write deadlines, and a 100,000-UTF-16-unit cumulative recording budget.
Override them through `limits`; diagnostics remain opt-in through `onDiagnostic` and never include prompt, memory, or credential text.

The factory scope is trusted configuration, not an authorization ceiling.
Resolve scope and overrides from authenticated application state.
During tool execution, the AI SDK `abortSignal` is forwarded to Iris.
Session hooks use the configured HTTP timeout.
SDK defaults disable automatic retries, avoiding duplicate appends after uncertain outcomes.

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
