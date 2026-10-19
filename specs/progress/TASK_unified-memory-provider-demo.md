# Unified provider demo migration

- Incorporated validated library/tools branch commit d6b9ee4 into the existing
  stacked provider branch with a normal merge.
- Moved only tracked demo2 files to demo/provider. The Anthropic model and factory
  are configured once; each serial turn creates a fresh memory.model().
- Preserved the ten original tests and added a unified API/per-turn construction/
  local root-resolution regression. RED against original source, GREEN after move.
- Preserved session continuity, /new, DEMO_SESSION_ID restart/resume, Anthropic
  keys/model override/default, diagnostics, and no tools/hooks/local history.
- Updated lockfile and local dependency to file:../.., private setup/start/test
  documentation, CI, CONTRIBUTING, and provider-specific README navigation.

## Final integrated verification
- npm run check: 178 library tests / 9 suites passed; typecheck/build; 44-file
  tarball allowlist inspection; installed ESM and NodeNext/Bundler consumers.
- npm --prefix demo/tools test: 18 passed.
- npm --prefix demo/provider test: 11 passed.
- Both locked npm ci installations and npm ls local root links verified; both
  migration tests assert resolved repository-root dist/index.js realpaths.
- Both documented startup directories work with fake credentials and mock
  preloads; startup/quit makes no service calls. Both demo suites exercise real
  application entrypoints with mocked HTTP; no live Iris/inference calls.
- Strict unused-code TypeScript, JavaScript syntax, and git diff --check pass.
- No dependencies added; ignored credentials/untracked workflow artifacts remain
  untouched. The npm allowlist excludes all demo applications and credentials.
