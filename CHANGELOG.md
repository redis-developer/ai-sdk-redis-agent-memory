# Changelog

## Unreleased

- Initial standalone `ai-sdk-redis-agent-memory` library for AI SDK 7.
- Added the unified root `createRedisAgentMemory({ serverUrl, storeId, apiKey,
  scope?, model?, allowDeletes?, namespaceTools?, timeoutMs? })` factory.
- Added `memory.tools({ scope? })` for explicit AI SDK memory tools and
  `memory.model({ scope?, model?, ...options })` for fresh request-scoped
  automatic-memory models. Tools do not require a configured model.
- Factory scope and model are optional defaults. `undefined` call options fall
  back to them; a supplied scope replaces the whole default scope, and a supplied
  configured model replaces the model default without mutating prior results.
- Retained non-enumerable toolset `withContext(scope)` for further scope narrowing
  and `createSessionEventHook(options)` for USER `onStart` and ASSISTANT `onEnd`
  recording, with explicit actors, sanitized errors, and optional observers.
- Removed the unreleased `RedisAgentMemory` class,
  `createRedisAgentMemoryTools(...)`, `createRedisAgentMemoryProvider(...)`,
  provider object/`forRequest(...)`, `wrap(...)`, and separate `./provider`
  public entry point. Their supported capabilities now live on the unified factory;
  provider-related public types are exported from the package root.
- Added automatic session restoration, scoped personal-memory recall, optional
  provenance, and best-effort session recording for automatic-memory models.
- Session events, session retrieval, long-term memory CRUD, semantic search, and
  optional namespace administration use the official
  `@redis-iris/agent-memory` SDK.
- Automatically generate UUIDs for new memories and return IDs in input order
  alongside per-record outcomes.
- Enforce user, session, and namespace scopes, including ownership checks and
  safe search filters. Factory scope is an overridable trusted default, not an
  authentication or authorization ceiling.
- Disable deletion and namespace administration tools by default; enable them
  with `allowDeletes` and `namespaceTools` on the unified factory.
- Added configurable `timeoutMs` with a 30-second default, cancellation, and
  sanitized tool errors.
- Reorganized runnable applications under `demo/tools/` and `demo/provider/`.
- Require AI SDK 7.0.114 or newer within 7.x and Zod 4.1.8 or newer within 4.x.
- Ship ESM output, TypeScript declarations, source maps, and MIT license.
