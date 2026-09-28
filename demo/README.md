# Minimal memory chat

A terminal chat using `ai-sdk-redis-agent-memory`, AI SDK, and Anthropic. It stores
user messages and assistant replies as Redis session events, and saves durable
facts for recall after you clear the chat or restart the app. Tool calls and
results are printed in cyan as `[memory] ...`; failures are red.

## Run

You need Node.js 22+, an Anthropic API key, and a Redis Agent Memory store and API
key from [Redis Cloud](https://cloud.redis.io/#/agent-memory).

Select Node.js 22 or newer first (`nvm install` from the repository root if you
use nvm), then run from the repository root:

```sh
npm ci
npm run build
cd demo
npm ci
cp .env.example .env
```

Fill in the three required values in `demo/.env`, then run from `demo/`:

```sh
npm start
```

You can also export the required environment variables instead of creating `.env`.
Exported values take precedence over `.env`.

If startup reports an older Node version, check `node --version` in the same
terminal. With nvm, run `nvm install 22` to install and select a supported version,
or `nvm use 24` if Node 24 is already installed, then retry `npm start`.

The default model is `claude-sonnet-4-5`; set `ANTHROPIC_MODEL` to use another
Anthropic model that supports tools. Set `AGENT_MEMORY_URL` if your store uses a
different endpoint. Calls use your Anthropic and Redis accounts.

Colors are enabled in interactive terminals. Set `NO_COLOR=1` to disable them,
or `FORCE_COLOR=1` to enable them when redirecting output. `FORCE_COLOR=0` also
disables colors; `NO_COLOR` takes precedence.

## Try it

```text
You: Remember that I prefer TypeScript examples.
  [memory] create_memories
  [memory] 1 saved; 0 failed.
  [memory] add_session_event (USER)
  [memory] USER session event saved.
  [memory] add_session_event (ASSISTANT)
  [memory] ASSISTANT session event saved.
Assistant: ...
You: /new
New conversation. Saved sessions and memories remain in Redis.
Session: <new session ID>
You: Which programming language do I prefer for examples?
  [memory] search_memories
  [memory] 1 found.
  [memory] add_session_event (USER)
  [memory] USER session event saved.
  [memory] add_session_event (ASSISTANT)
  [memory] ASSISTANT session event saved.
Assistant: ...
```

`/new` clears all messages and tool results from the model's local conversation
and generates a new session ID; saved sessions and long-term memories remain in
Redis according to your store's retention settings. `/quit` exits. Restarting
also starts a fresh session. Keep the same `DEMO_USER_ID` (default:
`demo-user`) to recall your memories, or change it to try a different user. This
is a local demo; the user ID is configuration, not authentication.

The session ID is printed at startup and after `/new`. After each completed
generation, the agent's `onEnd` hook calls `add_session_event` directly: first
for the latest user message, then for `finalStep.text`. It uses the user ID for
`USER` events and `demo-assistant` for `ASSISTANT` events. This runs once per
turn, so intermediate tool steps don't create duplicate events. The model can
read earlier completed turns with `get_session_memory`; the current turn is
saved only after generation finishes. Tool calls and results stay in local
model history.

The model chooses when to save and search long-term facts. New memories are
associated with the current session, while recall searches across the user's
sessions. Look for a successful save before testing recall; newly created
memories may take a moment to become searchable. Your store may also summarize
sessions and extract long-term facts in the background if configured to do so.
Deletion tools are disabled.

If a session write fails, the remaining writes for that turn stop and the reply
still appears in the local chat. Writes aren't automatically retried because an
event may already have been stored. Failed generations don't run `onEnd`, so
neither side of a failed turn is saved as a session event. A long-term memory
write may still have succeeded; ask the agent to recall it before saving again.

## Verify without credentials

After installing the dependencies and building the local library, run `npm test`
from `demo/`. The tests run the actual CLI and SDKs with mocked HTTP responses;
they check session logging, recall after `/new`, user/session scoping, failure
recovery, and console colors. They do not call Anthropic or Redis or load your
`.env`.

## Local package

`file:..` uses the library in this checkout, so no npm release is needed. Re-run
`npm run build` in the repository root after changing the library source.

This demo has its own dependencies and lockfile and is marked `private: true`.
The library's publishing allowlist excludes `demo/`, and its package check rejects
any demo files in the tarball. `.env` is ignored by Git; `.env.example` contains
only placeholders.
