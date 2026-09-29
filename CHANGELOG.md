# Changelog

## Unreleased

- Initial standalone `ai-sdk-redis-agent-memory` library for AI SDK 7.
- Require AI SDK 7.0.114 or newer within 7.x and Zod 4.1.8 or newer within 4.x.
- Update agent examples for AI SDK 7 stop conditions and final-step results.
- Session events, session retrieval, long-term memory CRUD, and semantic search
  backed by the official `@redis-iris/agent-memory` SDK.
- Automatically generate UUIDs for new memories and return their IDs in input
  order alongside per-record outcomes.
- Fixed user, session, and namespace scopes; optional namespace administration.
- Non-mutating `withContext(scope)` on class instances and factory results creates
  independent scoped tools sharing one client, while preserving fixed boundaries.
- Non-enumerable `createSessionEventHook(options)` creates scoped USER `onStart`
  and ASSISTANT `onEnd` callbacks, with explicit actor IDs, error reporting, and
  optional event observers. The demo records user input before model execution
  and the final assistant reply after completion.
- Public `scope.userId` maps to Redis ownership fields and identifies the actor
  for USER events.
- Positional factory and constructor arguments: `serverUrl`, `storeId`, `apiKey`,
  `scope`, and `options`; connection arguments retain environment defaults.
- Deletion and namespace administration tools disabled by default; opt in with
  `allowDeletes` and `namespaceTools`.
- Configurable `timeoutMs` with a 30-second default, cancellation, and sanitized
  tool errors.
- ESM output, TypeScript declarations, source maps, and MIT license.
