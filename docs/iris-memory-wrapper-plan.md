# Iris memory model wrapper plan

Status: implemented in [PR #2](https://github.com/redis-developer/ai-sdk-redis-agent-memory/pull/2), with the Anthropic demo in stacked [PR #3](https://github.com/redis-developer/ai-sdk-redis-agent-memory/pull/3). Updated 2026-10-08 to reflect the reusable factory and request-scoped model API. This document describes the delivered design; deferred features are not authorized by it.

## Purpose

Add an independent AI SDK model integration that restores Iris session context and retrieves relevant long-term memories automatically before inference. The default experience is to pick up where the conversation left off. Applications pass the wrapped model to ordinary AI SDK APIs; the model does not have to choose a memory tool. Iris-managed mode records session events by default to feed both future session restoration and Iris background extraction for cross-session recall; applications can explicitly disable recording.

Existing memory tools remain supported and unchanged. The wrapper must work without constructing a toolset, executing a tool, or installing application lifecycle hooks.

## Integration boundary

- Configure an underlying language model and Iris connection once in `createRedisAgentMemoryProvider({ model, serverUrl, storeId, apiKey })`. `model` is required and accepts the configured-model type used by AI SDK `wrapLanguageModel` (V2, V3, or V4), not a provider/model string ID.
- Use AI SDK model middleware internally, targeting the repository's AI SDK 7 contract. Support `generateText`, `streamText`, and tool-loop agents.
- Publish `createRedisAgentMemoryProvider`, `RedisAgentMemoryProvider`, and related declarations through the independent `ai-sdk-redis-agent-memory/provider` entry point. Existing root tools and hooks remain compatible.
- Bind the store/connection at factory creation and copy immutable authenticated `userId` and request scope in `memory.forRequest(options)`. Require `sessionId` in default Iris-managed history mode or whenever recording is enabled, and a valid `assistantId` whenever recording is enabled. Never infer identity or widen scope from prompt content.
- Create a fresh request model with `memory.forRequest(options)` for each application request. Reuse that result across the request's tool-loop steps and retries, never across independent requests. One factory shares its configured underlying model and Iris client, but no mutable request state. Factory and request-model construction make no network calls. Overlapping calls on one request model are rejected with `INVALID_WRAPPER_USE`; separate request models can run concurrently for distinct sessions.
- Require the application to globally serialize independent requests by exact session ID: one active application request per session, even if callers claim different users. Different sessions can run concurrently. Do not introduce distributed locking or promise cross-request ordering the wrapper cannot enforce.
- Read personal long-term memories only in v1, across sessions within the configured scope. Restore working context only from the specified session, with ownership and scope validation.

AI SDK documents RAG through `transformParams`, while provider factories can compose wrapped models. Middleware observes individual model calls, not complete application turns. [Middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware), [provider management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management), [tool loops](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling).

## Public API and request ownership

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { ToolLoopAgent, isStepCount } from 'ai';
import { createRedisAgentMemoryProvider } from 'ai-sdk-redis-agent-memory/provider';

// Application configuration: shared across requests.
const memory = createRedisAgentMemoryProvider({
  serverUrl: process.env.AGENT_MEMORY_URL,
  storeId: process.env.AGENT_MEMORY_STORE_ID,
  apiKey: process.env.AGENT_MEMORY_API_KEY,
  model: anthropic('claude-sonnet-4-5'),
});

// Inside each application request; IDs come from authenticated application state.
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

`RedisAgentMemoryProviderOptions.model` is required. The factory returns an
immutable `RedisAgentMemoryProvider` exposing only
`forRequest(options: RedisAgentMemoryModelOptions)`. This intentionally replaces
the unreleased `wrap(model, options)` API; there is no compatibility alias.
Invalid configured models and connection settings fail at factory construction.

Per-request options remain `scope`, `assistantId`, `historyMode`, `recording`,
`query`, `strictReads`, `includeMemoryProvenance`, `limits`, and `onDiagnostic`.
Each `forRequest()` validates/copies its options and returns an AI SDK V4-compatible
wrapped model. The factory itself is not a language model: passing `model: memory`
to a singleton agent is unsupported. Automatic agent-level request lifecycle
integration remains outside this change.

| Lifetime | Owned state |
| --- | --- |
| Reusable factory | Configured underlying model and resolved Iris client/connection |
| Each request model | Copied scope and options; initial USER text and query; cached restoration/recall snapshot; single USER-write attempt; remaining recording budget and assistant-recording invariant latch; active-call/cancellation state; monotonic timestamps and write sequencing |

Reads and recording begin only on model invocation. The first invocation captures
one bounded snapshot and USER attempt; subsequent steps/retries reuse them. A new
request performs fresh reads and records its own current USER input, even when its
model was constructed before an earlier request completed. Request-local state is
not a cross-request cache, session lock, or exactly-once delivery mechanism.

## Retrieval and context

Two explicit history modes avoid silently merging independently maintained histories:

- **Iris-managed history is the default.** At the beginning of a request, the caller supplies current application instructions and the new user message. The wrapper restores prior session context, then preserves current-request model/tool-loop messages as the request progresses. Caller-supplied historical conversation must not be silently merged into this mode.
- **Application-managed history is an opt-out from restoration.** The caller supplies the conversation; the wrapper only adds long-term recall by default. Recording remains opt-in in this mode. A session ID is optional here unless recording is enabled.

The primary usage example uses default Iris-managed restoration and recording. Its documentation must clearly state that conversational text is sent to Iris. An explicit recording opt-out disables all user and assistant writes without disabling reads; in that configuration, future restoration depends on history populated separately.

1. Capture the latest user text on the first invocation of the request model as its search query, unless the application supplies an explicit override. Do not make an additional LLM call to formulate it.
2. Retrieve session context and long-term memories concurrently, with at most one attempt at each read per wrapper/request and a shared one-second deadline. Reuse that bounded snapshot across steps and retries, including empty or failed results. Do not cache across requests.
3. Skip long-term search when neither user text nor an explicit query is available. Session restoration remains independent of the search query.
4. Enforce owner and configured namespace restrictions independently of model-generated content. A session identifier must not accidentally restrict long-term recall to that session.
5. Restore the available summary and newest retained conversation messages within the session-context budget, preserving their order. Fetch before writing the new user event so it is not restored twice. Retain the current user message and current-request tool-loop messages exactly once, without duplicating restored context on later steps.
6. Inject clearly delimited reference context, identifying memories and derived summaries as potentially stale and untrusted rather than instructions. Preserve current application instructions and original current-request messages. Restored historical content must not override current application instructions.
7. Never record restored or injected context back into Iris. Prompt labeling mitigates but cannot eliminate prompt-injection risk.

Configurable starting defaults:

| Setting | Default |
| --- | --- |
| Retrieved memories | 5 |
| Total injected long-term memory section | 8,000 characters |
| Restored session context | 24,000 characters |
| Shared deadline for concurrent session and long-term reads | 1 second |
| Deadline per recording operation | 1 second |
| Cumulative recording budget per request | 100,000 UTF-16 units |

Prefer the available summary and newest conversation messages when selecting session context; report omitted history through diagnostics. Never truncate the caller's current input. These are initial product limits, not measured performance guarantees. Character budgets count UTF-16 units, not tokens. The fixed outer `IRIS MEMORY CONTEXT MAY BE STALE.\n` notice adds 34 UTF-16 units outside the independent session and long-term-memory section budgets. An oversized assistant recording event is skipped whole; it does not consume the remaining budget or prevent a later smaller assistant event. Attempted POSTs consume their text budget even when acknowledgement is uncertain.

Iris returns an optional summary and retained events; restoration is not a promise of a complete verbatim transcript. The published SDK exposes no pagination or server-side history limit, so the session budget limits prompt injection, not the fetched response size. Its generic not-found response does not distinguish expired, deleted, and never-created sessions. Treat these as an unavailable session: start with the current message and any available long-term recall, and emit a diagnostic without inventing the cause. [Version-pinned SDK artifact](https://registry.npmjs.org/@redis-iris/agent-memory/-/agent-memory-0.3.1.tgz).

## Recording defaults and boundaries

Recording defaults to enabled in Iris-managed mode and disabled in application-managed mode, with an explicit override independent of reads. This supersedes the interview's earlier blanket opt-in decision so default session continuity works without a separate writer. Application consent and pre-storage data handling remain the application's responsibility.

Recording covers the latest user input and each successful assistant response containing text, including intermediate assistant text and the final answer when successfully completed. There is no separate final-answer-only toggle in v1: a standalone model wrapper cannot reliably identify the end of every application run. Intermediate text may be restored later without its associated tool payloads, which are excluded from recording.

- After the restoration read has completed or reached its deadline, attempt to record the latest user text once per wrapper/request, before generating assistant events. Do not backfill supplied or restored history.
- After each successful model step, record newly generated assistant text, including intermediate assistant text. Empty assistant text produces no event.
- Exclude system instructions, injected memories, reasoning, tool arguments/results, and binary content. Text parts of otherwise multimodal messages may participate; original model inputs pass through unchanged.
- For streams, pass nonterminal chunks through without buffering their delivery. Accumulate only the assistant text needed for recording. Persist it after raw provider finish plus normal source close, with bounded persistence before signaling terminal completion. Failed or cancelled raw streams must not produce an assistant event; downstream consumption is not observable and is not a recording condition.
- Use the authenticated user principal as the USER event actor. If its write is not confirmed successful, suppress all further recording for that request and report a diagnostic. Do not risk establishing a new session with an assistant-owned first event.
- Do not retry session writes automatically. Recording is best-effort, not exactly-once. Application retries with a fresh wrapper can still create duplicate events; ambiguous timeouts can mean a write succeeded remotely.
- Do not combine automatic recording with existing recording hooks for the same interactions. Tools may coexist, but applications must avoid duplicate recording responsibilities.

Iris automatically extracts long-term memories from session events asynchronously; a just-recorded fact may not be searchable immediately. Extraction exclusions do not redact raw session events, so consent and pre-storage data minimization remain application responsibilities. [Iris quickstart](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/typescript-sdk-quickstart/), [developer guide](https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/developer-guide/).

The published Iris SDK 0.3.1 exposes no documented session-write idempotency key or caller event ID; its session schema assigns ownership from the first event's actor. Ownership preflight and new-session USER postflight checks detect violations, but Iris has no conditional session creation: a race can already have accepted a cross-principal USER event before detection. Postflight cannot undo that write, so authenticated collision-resistant IDs and exact-session serialization remain required. A durable client outbox alone cannot guarantee exactly-once remote effects after ambiguous success. [Version-pinned SDK artifact](https://registry.npmjs.org/@redis-iris/agent-memory/-/agent-memory-0.3.1.tgz).

## Errors and diagnostics

- Default retrieval behavior is fail-open: bounded operational failure in session restoration or long-term search does not prevent model generation. Use any successful read result independently; never claim that missing history was restored. Empty long-term results and unavailable sessions are normal outcomes, not operational errors.
- Optional strict mode fails before generation when either required read fails operationally. It does not reject an ordinary absent session or turn recording failures into generation failures.
- Invalid configuration and missing required identity always throw. Never bypass scope enforcement as a fallback.
- Preserve underlying model failures and cancellation behavior; memory failure handling must not mask them.
- Offer an optional structured diagnostic callback with operation, outcome, duration, counts, truncation, and sanitized errors. Exclude prompt and memory text and credentials. No default console logging.
- Diagnostic callback failures must not break generation. No untracked fire-and-forget memory writes.

## Optional memory provenance

Offer explicit opt-in provenance for the long-term memories actually included in model context, through AI SDK response/stream metadata. Keep existing underlying provider metadata intact. The public field is `providerMetadata.redisAgentMemory.memories`, with entries allowlisted to `id`, `memoryType`, `createdAt`, and `updatedAt`. If the underlying model already owns `redisAgentMemory`, preserve all its metadata unchanged and omit wrapper provenance, reporting a collision diagnostic.

- Disable provenance by default. When enabled, expose memory IDs and an allowlisted set of safe descriptive metadata, not raw memory text, prompts, credentials, or arbitrary stored metadata.
- Report only records retained after context-budget selection, not every retrieved candidate. Apply the same scope boundaries as retrieval and do not perform extra memory reads to populate provenance.
- Preserve provenance availability for both ordinary generation and streaming. Reused request snapshots should report a consistent set of included memories across steps.
- Provenance means the memory was supplied as context, not proof that the model relied on it or that the memory is correct. Keep operational diagnostics content-free regardless of this option.

This adopts Mem0's useful programmatic source-attribution pattern while making exposure opt-in and limiting the returned data. [Mem0 source attribution](https://docs.mem0.ai/integrations/vercel-ai-sdk).

## Delivered implementation

1. Regression tests lock existing tool/hook ownership, namespace isolation, and recording behavior.
2. `src/scoped-memory.ts` provides the shared tool-independent client, validation, and scoped-operation seam without executing tool handlers or adding dependencies.
3. `src/provider.ts` implements the reusable configured factory and isolated request models, default session restoration, application-managed opt-out, and bounded context injection for generation and streaming.
4. Each request model owns USER-write state and per-successful-step assistant recording, with retry, cancellation, ownership, budget, and sequencing safeguards.
5. The independent package export, optional provenance, README examples, current design/roadmap, and packed-consumer checks document and validate the public API. Existing tools/hooks are unchanged; the unreleased `wrap()` API is intentionally replaced.
6. Focused tests and `npm run check` cover typechecking, tests, build, and packed-package consumer validation. There is no standalone lint script.

## Acceptance criteria and verified evidence

- A model without memory tools receives scoped Iris context before inference in both generate and stream paths.
- Default Iris-managed mode resumes the same session on a fresh wrapper using available summary and recent events. Application-managed mode makes no session-history read. Both modes validate required identity and preserve current application instructions.
- Restoration precedes the user-event write. Restored history, the new user message, and later tool-loop messages are each included once; incompatible supplied history is not silently merged.
- Cross-user and cross-namespace isolation survives query overrides, failures, and simultaneous independently scoped wrappers.
- Each request model performs at most one restoration read and one long-term search (recording ownership checks are separate), including tool-loop steps and provider retries; prompt inputs are not mutated and injected context is not duplicated.
- Two request models from the same factory have independent snapshots, USER-write state, recording budgets/invariant latches, query/scope, and concurrency/cancellation state. A second request performs fresh reads and records its own USER event; cancellation of one concurrent request does not affect another. Overlapping calls on the same request model remain rejected.
- Separate context budgets, a shared read deadline, query overrides, no-text input, absent/expired sessions, summaries, empty results, partial read failure, strict mode, and diagnostic sanitization have focused tests. The caller's current input is never truncated by memory budgeting.
- User recording has at most one attempt per wrapper. A failed or ambiguous user write suppresses assistant writes. Fresh-wrapper retries are documented as potentially duplicating events.
- Iris-managed mode records by default; its recording opt-out suppresses all user and assistant writes while preserving reads. Application-managed mode records only when explicitly enabled.
- Each successful assistant step records only generated text. Tests cover text-only, mixed text/tool responses, tool-only responses, reasoning parts, stream errors, cancellation, and raw completion without downstream consumption.
- Streaming preserves provider chunks and non-text events while awaiting only bounded end-of-stream persistence.
- Provenance is absent by default. Opt-in generate and stream tests expose only included, in-scope memory IDs and allowlisted metadata, preserve existing provider metadata, and exclude raw text and arbitrary stored metadata. Provenance requires no additional memory calls.
- Existing tool and lifecycle-hook tests still pass. Packed ESM consumers construct the new factory and request models without network calls and reject missing/string/malformed models. NodeNext and Bundler consumers accept configured models and reject missing/string/optional-undefined/malformed models and the removed `wrap()` API; the result is assignable to a `ToolLoopAgent` model.
- No live Iris or inference calls are required for automated tests; any later live validation requires its own credentials and authorization.
- Usage documentation and examples require application-owned per-session serialization and clearly disclose default recording in Iris-managed mode, the recording opt-out, and inclusion of intermediate assistant text. No distributed-lock, final-answer-only, or complete-transcript guarantee is claimed.

### Validation recorded for the API revision

- Test-first request-model and invalid-model regression tests failed against the
  old API/validation before implementation; packed ESM checks rejected the old
  `wrap` surface before migration.
- `npm run check`: **182 library tests across 8 suites passed**, plus typecheck,
  build, tarball inspection, ESM runtime consumers, and NodeNext/Bundler declaration
  consumers.
- `tsc --noEmit --noUnusedLocals --noUnusedParameters`, JavaScript syntax checks,
  and `git diff --check` passed. No standalone lint script is configured.
- The stacked Anthropic `demo2` configures `anthropic(modelName)` once and calls
  `memory.forRequest()` inside its serial chat loop for every turn. It retains the
  session across turns, changes it with `/new`, and resumes via `DEMO_SESSION_ID`.
  `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and default `claude-sonnet-4-5` are
  unchanged. There are no memory tools, recording hooks, or local history array.
- **10 mocked demo2 tests** and **17 original-demo tests** passed, including fresh
  request state after a failed turn, continuity/resume, model override, scope
  enforcement, sanitized diagnostics, and zero-network configuration/commands.
  The original `demo/` remains unchanged.
- Node.js **22 and 24 CI passed for both PRs** for the API revision. All automated
  service calls were mocked; package checks accessed npm only for existing
  consumer dependencies. No dependencies were added.

## Deferred scope

See the [Iris memory roadmap](iris-memory-roadmap.md). Deferred features are captured for future planning, not silently included in v1.

## Prior art

Vercel's Mem0 example supports the provider-like user experience without model-selected memory tools. It is an ergonomic precedent, not evidence of exactly-once recording or complete-run lifecycle visibility. AI SDK's caching middleware illustrates separate stream-completion handling. [Memory integrations](https://ai-sdk.dev/docs/agents/memory), [caching middleware](https://ai-sdk.dev/docs/advanced/caching).
