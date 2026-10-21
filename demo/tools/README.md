# Minimal memory chat

A terminal chat using `ai-sdk-redis-agent-memory`, AI SDK, and Anthropic. It stores
user messages and assistant replies as Redis session events, and saves durable
facts for recall after you start a new conversation or restart the app. Tool calls and
results are printed in cyan as `[memory] ...`; failures are red.

## Run

You need Node.js 22+, an Anthropic API key, and a Redis Agent Memory store and API
key from [Redis Cloud](https://cloud.redis.io/#/agent-memory).

Select Node.js 22 or newer first (`nvm install` from the repository root if you
use nvm), then run from the repository root:

```sh
npm ci
npm run build
cd demo/tools
npm ci
cp .env.example .env
```

Fill in the three required values in `demo/tools/.env`, then run from `demo/tools/`:

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
  [memory] add_session_event (USER)
  [memory] USER session event saved.
  [memory] create_memories
  [memory] 1 saved; 0 failed.
  [memory] add_session_event (ASSISTANT)
  [memory] ASSISTANT session event saved.
Assistant: ...
You: /new
New conversation. Saved sessions and memories remain in Redis.
Session: <new session ID>
You: Which programming language do I prefer for examples?
  [memory] add_session_event (USER)
  [memory] USER session event saved.
  [memory] search_memories
  [memory] 1 found.
  [memory] add_session_event (ASSISTANT)
  [memory] ASSISTANT session event saved.
Assistant: ...
```

`/new` clears all messages and tool results from the model's local conversation
and generates a new session ID; saved sessions and long-term memories remain in
Redis according to your store's retention settings. `/clear` clears the terminal
screen while keeping the current conversation, session, and saved memories.
It makes no API calls and has no effect on piped output. `/quit` exits.
Restarting also starts a fresh session. Keep the same `DEMO_USER_ID` (default:
`demo-user`) to recall your memories, or change it to try a different user. This
is a local demo; the user ID is configuration, not authentication.

The demo creates one memory factory with `createRedisAgentMemory`, binding
the stable user ID once. Each conversation calls `memory.tools({ scope: { userId, sessionId } })`
to get its own scoped tools while sharing the original client.

The session ID is printed at startup and after `/new`. The agent uses the
toolset's session event hooks with shared logging callbacks:

```js
const sessionObservers = {
  onEventStart: ({ role }) => logMemory(`add_session_event (${role})`),
  onEventSaved: ({ role }) => logMemory(`${role} session event saved.`),
  onError: (error, { role, phase }) => {
    logMemoryError(`${role} session save failed`, error);
    if (phase === 'write') {
      logMemory('Session save was not confirmed; the event may already be stored. Verify before retrying.', true);
    }
  },
};

const agent = new ToolLoopAgent({
  model,
  tools,
  onStart: tools.createSessionEventHook({
    ...sessionObservers, role: 'USER', actorId: userId,
  }),
  onEnd: tools.createSessionEventHook({
    ...sessionObservers, role: 'ASSISTANT', actorId: 'demo-assistant',
  }),
  // Other agent options omitted here.
});
```

`onStart` records the current user message before the model runs. Its actor ID
must match the scoped user ID. After generation completes, `onEnd` records
`finalStep.text` with `demo-assistant` as its actor. Empty assistant replies are
skipped. Each hook runs once per turn; intermediate steps do not create events.
No `include.requestMessages` setting is needed.
Session-write tools are excluded from `activeTools` so the model does not
duplicate those events. Hook writes use their own event observers for logging;
they do not trigger the AI SDK's tool-execution callbacks.

The model can read saved history with `get_session_memory`, including the
current user message once its save succeeds. Tool calls and results stay in
local model history. The helpers record text only; see the library's
[session event hook documentation](../../README.md#recording-session-events) for
input requirements and error context.

The model chooses when to save and search long-term facts. New memories are
associated with the current session, while recall searches across the user's
sessions. Look for a successful save before testing recall; newly created
memories may take a moment to become searchable. Your store may also summarize
sessions and extract long-term facts in the background if configured to do so.
Deletion tools are disabled.

The hooks report save failures through their required `onError` callback;
AI SDK ignores lifecycle callback exceptions. A USER save failure does not
stop generation or the independent ASSISTANT hook. An uncertain user write may
already have committed, allowing the assistant event to be saved afterward.
Writes are not atomic, retried, or deduplicated. If generation fails before
`onEnd`, the saved USER message remains in Redis and no ASSISTANT event is recorded.
A long-term memory write may also have succeeded; ask the agent to recall it
before saving again.

When a request fails, the demo identifies Anthropic or Redis when the error's
source is known, preserves the underlying error details, and suggests a next
step. For example:

```text
Request failed: The request to Anthropic received HTTP 503 (Service Unavailable).
Details: AI_APICallError (HTTP 503): Service Unavailable
Next: Check https://status.claude.com and your network/proxy before trying again.
```

Authentication errors point to the relevant API key; missing models, rate limits,
DNS failures, and timeouts have separate guidance. Redis session errors identify
the USER or ASSISTANT event, and tool errors identify the failing tool. Unknown
SDK/application errors are reported without attributing them to a service.
Configured API keys are redacted; diagnostics are limited in length and omit
SDK request/response objects, headers, and stacks. Failures are not retried
automatically; check saved session history before resubmitting a failed turn.

## Verify without credentials

After installing the dependencies and building the local library, run `npm test`
from `demo/tools/`. The tests run the actual CLI and SDKs with mocked HTTP responses;
they check session logging, recall after `/new`, user/session scoping, failure
recovery, and console colors. They do not call Anthropic or Redis or load your
`.env`.

## Local package

`file:../..` uses the library in this checkout, so no npm release is needed. Re-run
`npm run build` in the repository root after changing the library source.

This demo has its own dependencies and lockfile and is marked `private: true`.
The library's publishing allowlist excludes `demo/tools/`, and its package check rejects
any demo files in the tarball. `.env` is ignored by Git; `.env.example` contains
only placeholders.
