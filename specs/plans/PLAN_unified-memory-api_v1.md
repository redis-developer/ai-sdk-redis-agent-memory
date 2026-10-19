# Unified memory API implementation plan

## Contract and scope
Implement docs/unified-memory-api-agent-prompt.md on the existing stacked PRs.
Use one root factory and one shared client, with whole-scope replacement and
fresh request-local model state. Preserve tool/hook security and model semantics.
No dependencies, live services, credential moves, or unrelated artifact edits.

## Sequence and acceptance
1. Lock factory defaults, overrides, isolation, validation, and packed consumers
   with failing public API tests; adapt existing behavior coverage without removing it.
2. Replace redundant factories/class with createRedisAgentMemory, tools(), model().
   Retain withContext as a non-enumerable narrowing helper and session hooks.
3. Move only tracked tools demo files to demo/tools, migrate calls, and add
   relocation/API tests. Retain every existing behavioral test.
4. Update substantive README and delivered-design documentation in PR #2.
5. Run npm run check and tools suite, independent critical review, commit/push #2.
6. Merge library branch into #3; move tracked demo2 files to demo/provider;
   configure once and construct a fresh model inside every serial chat turn.
7. Run full package and both demo checks, mocked startup and local-resolution
   validation; review, commit/push #3; refresh descriptions and verify stack diffs.

## Risks and stop condition
Scope defaults are not authorization ceilings: trusted application state supplies
all overrides. Construction must remain offline. Never move untracked .env files.
Stop after verified remote heads/bases/diffs, or report specific infrastructure
blockers with local validation evidence. No lint script exists; TypeScript and
package consumer compilation provide static checks.

## Review resolutions and concrete contract
- Preflight completed before edits: clean tracked tree; untracked prompt and OMX
  artifacts preserved. Fetched origin. PR #2 is feat/iris-memory-provider -> main;
  PR #3 is feat/anthropic-memory-wrapper-demo -> feat/iris-memory-provider.
- Root `ai-sdk-redis-agent-memory` is canonical. Remove `./provider` export,
  createRedisAgentMemoryProvider/forRequest, createRedisAgentMemoryTools and the
  RedisAgentMemory constructor. RedisAgentMemory becomes the factory-result type.
  Retain tools-result withContext as monotonic narrowing, and session hooks.
- API owner: src/**, test/**, package.json, scripts/check-package.mjs. Documentation
  owner: README, CHANGELOG, docs/iris-memory-{wrapper-plan,roadmap}. Leader owns
  demos, CI, CONTRIBUTING, integration, publication, and final evidence.
- Explicit tests: omitted/undefined fallback for scope/model; whole-scope
  replacement on both products with no inherited session/namespace; input/default/
  prior-result immutability; unscoped/tools-only use; missing/string/malformed
  model synchronous safe failure without fetch/inference; actual override-model
  invocation. Existing tests retain fresh reads/USER attempt per request, shared
  snapshot and one USER attempt across retries/steps, isolated query/budget/latch/
  cancellation/timestamps/sequencing, concurrency, and overlap rejection.
- Packed checks cover root/removed exports, offline construction, ESM, NodeNext,
  Bundler, definite/optional/absent default model and invalid call combinations.
- Each demo: tracked files only; manifest and lockfile file:../..; imports and
  fixtures; README install/start/test and .env.example references; realpath root
  resolution; existing behavioral suite plus migration regression; mocked startup.
  Update CI and CONTRIBUTING. npm-pack allowlist excludes demos and credentials.
- README acceptance: preserve both approaches, substantive examples, configuration,
  hooks (including observers/failure semantics), tools/security/reference sections.
  Document trusted scopes, whole replacement vs narrowing, request lifetime and
  exact-session serialization, and each removed API's replacement. Search for
  stale calls/paths and review substantive sections, links, and anchors.
- Stack integration: commit/push validated PR2, merge that exact branch head into
  PR3 without force-push; resolve shared README by preserving updated PR2 content,
  then add only provider-specific navigation on PR3. Verify remote head SHAs and
  bases via gh pr view and git ls-remote; verify origin/PR2...origin/PR3 --name-status
  includes provider-specific changes only, with no library/tools duplicate diffs,
  no tracked demo2 application, and no tracked flat demo application.
