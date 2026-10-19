# Contributing

Use Node.js 22 or newer and npm. With nvm, run `nvm use` first.

```sh
npm ci
npm run check
```

`npm run check` typechecks source and tests, runs the test suite, builds the
library, and installs the packed npm artifact in a temporary consumer project
to verify runtime exports and TypeScript declarations. The package check needs
access to the npm registry/cache. Tests use mocked transports and models; no
Redis or model credentials are needed and no live API calls are made.

To run the tools demo tests after building the library:

```sh
npm --prefix demo/tools ci
npm --prefix demo/tools test
```

Useful commands:

- `npm run build`: clean and compile the publishable ESM output.
- `npm run typecheck`: typecheck source and tests.
- `npm test`: run tests once.
- `npm run test:watch`: rerun tests during development.
- `npm run check:package`: build, inspect, and smoke-test the npm tarball.
- `npm pack --dry-run`: preview the files included in a release.

## Layout

```text
.github/workflows/   Continuous integration
src/                 Library implementation and public entry point
test/                Unit and integration tests with mocked HTTP/model boundaries
scripts/             Package validation tooling
demo/tools/          Tools-based terminal chat (private; excluded from npm releases)
dist/                Generated JavaScript, declarations, and maps (not committed)
```

`package.json` defines the public API through `exports` and limits published
files through `files`. Source files are included so declaration maps resolve in
consumer editors. Tests, CI configuration, and development dependencies are not
part of the tarball. Keep `package-lock.json` committed for reproducible CI;
npm does not ship it with the library.

## Releasing to npm

Publishing is a separate, explicit maintainer action. CI validates changes but
does not publish packages automatically.

1. Update `CHANGELOG.md` and choose a new semantic version in `package.json`
   and `package-lock.json` (for example, `npm version patch --no-git-tag-version`).
   The initial release can use the existing `0.1.0` version.
2. Run `npm ci`, `npm run check`, and `npm pack --dry-run` from a clean checkout.
3. Review and commit the release, and confirm access to the npm package name.
4. Authenticate to npm with the maintainer's account and run `npm publish`.
   `prepublishOnly` reruns validation; `prepack` always rebuilds the output.
5. Tag the released commit as `v<version>` and create the corresponding GitHub
   release after publishing succeeds.

Do not commit API keys, npm tokens, or `.env` files. For future automated releases,
prefer [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) over
long-lived registry tokens.
