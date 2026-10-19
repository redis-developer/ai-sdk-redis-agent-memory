# Unified memory API progress

## PR #2: library and tools demo
- Added root createRedisAgentMemory factory with shared client, optional immutable
  defaults, whole-scope replacement, tools(), and fresh request-scoped model().
- Removed redundant public tools factory/class and provider/forRequest subpath.
  Retained narrowing withContext and application session hooks on toolsets.
- Migrated existing behavior suites and packed ESM/NodeNext/Bundler consumers.
- Moved tracked tools application files to demo/tools, updated lockfile/local
  dependency, configuration diagnostics, docs, CI, and migration/resolution tests.
- Preserved substantive tools/hooks/security docs alongside model approach.

## Test-first and verification evidence
- New unified factory tests failed against the old library: four expected
  `createRedisAgentMemory is not a function` failures before implementation.
- New tools migration test failed against old application: 17 existing tests
  passed, 1 expected API/path failure. All 18 pass after migration.
- New provider migration regression failed against the tracked original demo2
  source in an isolated temporary staging directory before migration.
- npm run check: passed, 178 library tests across 9 suites; typecheck, build,
  tarball allowlist (44 files), installed ESM runtime, NodeNext and Bundler.
- Strict noUnusedLocals/noUnusedParameters compilation, JavaScript syntax checks,
  and git diff --check passed. No standalone lint script exists.
- Tools npm ci completed; npm ls verifies local root link; test realpath confirms
  dist/index.js in repository root. Mock-preloaded startup/quit succeeds.
- No live Iris or inference calls; no dependencies added; ignored credentials and
  untracked OMX/prompt files preserved. Package registry access was needed for
  existing locked demo and temporary consumer dependencies.

## Independent review
- Addressed malformed configured-model validation with four failing regressions
  before tightening literal version and required supportedUrls checks.
- Kept provider-demo navigation on PR #3 so PR #2 has no broken relative link.

## Stack handoff
PR #3 will merge the validated PR #2 commit and contain the provider-only move to
 demo/provider plus its integration/navigation changes. Final combined evidence
will be recorded separately on that branch and in the PR descriptions.
