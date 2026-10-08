# Anthropic automatic-memory demo

This private Node.js 22 CLI shows the provider wrapper with Anthropic. The application sends only the current prompt and a short system instruction. A fresh wrapped model restores the configured Iris session, recalls relevant long-term memory, calls Anthropic, and records the turn automatically—there are no memory tools or local chat-history array.

## Setup

From the repository root, build the local package first:

```sh
npm ci
npm run build
cd demo2
npm ci
cp .env.example .env
```

Fill in `ANTHROPIC_API_KEY`, `AGENT_MEMORY_API_KEY`, and `AGENT_MEMORY_STORE_ID`, then run:

```sh
npm start
```

Shell-exported variables take precedence over the optional `demo2/.env` file. The demo uses Anthropic's Messages API with `claude-sonnet-4-5` by default; override it with `ANTHROPIC_MODEL`. Calls use the real Anthropic and Redis Agent Memory services and may incur charges.

## Try it

1. Ask a question, then ask a follow-up in the same process. The CLI sends only the new prompt; Iris restores the earlier session turn for the model.
2. Exit with `/quit`, then restart with the printed value: `DEMO_SESSION_ID=<printed-uuid> npm start`. Ask another follow-up to continue that exact session.
3. Enter `/new` to use a fresh session with the same user identity. Long-term-memory extraction is asynchronous, so do not expect a just-mentioned fact to be available there immediately.

## Sessions and memory behavior

- Keep `DEMO_USER_ID` stable to retain the same long-term-memory owner. If resuming a session created with the previous demo2 provider, retain its original user ID rather than adopting the new `demo-user` default.
- The CLI prints its session UUID. To continue that exact session after a restart, run `DEMO_SESSION_ID=<printed-uuid> npm start` or put the UUID in `.env`.
- Do not run parallel processes with the same `DEMO_SESSION_ID`; a wrapper is intended to own one turn at a time.
- `/new` creates a new session while preserving the user and long-term-memory scope. `/clear` clears the terminal and `/quit` exits.
- Iris long-term-memory extraction can be asynchronous, so a fact from the prior session is not guaranteed to be recallable immediately after `/new`.
- Default reads and writes are best effort. Diagnostics show only operation, outcome, counts, write status, and HTTP status; they do not print response bodies, prompts, or credentials. An uncertain write may have reached the service even when its acknowledgement failed.
- Default recording sends the current USER text and generated assistant text to Iris. This demo intentionally exposes no memory or deletion tools, so the assistant should not promise that information was permanently saved or removed.
- `DEMO_USER_ID` and `DEMO_SESSION_ID` are local demo scope identifiers, not authentication or authorization. Production applications must derive user scope from authenticated identity and globally serialize access to an exact session ID across processes and instances.

## Test without live services

```sh
npm test
```

The subprocess tests replace network transport and never use real credentials.
