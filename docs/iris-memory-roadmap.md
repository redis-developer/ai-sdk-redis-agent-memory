# Iris memory integration roadmap

The first release delivers an independent, request-scoped model wrapper with default Iris session restoration, automatic personal long-term recall, and best-effort session recording enabled by default in Iris-managed mode. Applications can explicitly disable recording or manage history themselves; application-managed mode retains opt-in recording. The [v1 design](iris-memory-wrapper-plan.md) documents the implemented API and boundaries. The current root API creates both products with `createRedisAgentMemory({ ...connection, scope?, model? })`. Applications use `memory.tools({ scope? })` for explicit tools and create isolated automatic-memory models with `memory.model({ scope?, model?, ...options })` for each application request. Factory scope and model are optional defaults; a defined call-level scope replaces the whole default scope. Steps and retries within a request reuse that model; independent requests do not.

Optional memory provenance is included in v1: applications can inspect IDs and safe metadata for long-term memories supplied as context, without exposing raw memory text by default.

Session history and summary restoration moved into v1 during the design interview and are no longer deferred. Restoration uses bounded available context, not a guaranteed complete transcript; applications serialize requests within each session.

The following features are deliberately deferred. Their grouping is a proposed planning order, not a delivery commitment or authorization to implement them.

## Model selection conveniences

**Provider name registry and aliases.** Allow applications to select named models through an Iris provider factory instead of passing a configured model object.

Revisit when applications need a reusable model catalog. Build on the same wrapper, preserving provider-specific credentials and configuration rather than implementing inference transports. Decide alias/fallback behavior and identity binding before adding the API.

## Recall improvements

**Shared application and team memory.** Extend recall beyond the current user's personal memories.

Prerequisites: explicit trusted authorization scope, namespace allowlists, personal/shared ranking and conflict rules, and isolation tests. No implicit widening of access.

**Conversation-aware query generation.** Improve ambiguous follow-ups by using bounded recent context or an additional LLM-generated search query.

Revisit after evaluating missed recall with the latest-user-text baseline. Measure relevance against extra latency and cost; specify which conversation data reaches the query model and what happens when it fails.

## Recording guarantees and lifecycle extensions

**Durable delivery and reconciliation.** Offer stronger delivery behavior than request-local best-effort recording.

Prerequisites: explicit application lifecycle/storage integration and a verified server idempotency or equivalent atomic deduplication/reconciliation contract before promising exactly-once effects. A queue or outbox alone does not close ambiguous remote success. Retention, ordering, retry limits, and dead-letter handling need a separate design.

**Automatic agent-level request lifecycle integration.** Passing the reusable factory as `model: memory` to a singleton agent is not supported. Applications explicitly call `memory.model()` inside each request; an automatic lifecycle adapter remains separate future work.

**Complete application turn recording.** An optional run-level adapter could record the user input and only the final user-facing response rather than intermediate assistant text. The v1 decision favors standalone model integration and accepts recording successful intermediate assistant text; final-answer-only behavior remains deferred.

Prerequisites: a clear end-of-run signal, stream/cancellation semantics, and prevention of duplicate writes when mixed with model-level recording. Preserve the standalone wrapper for applications that do not want lifecycle adapters.

## Roadmap review criteria

Promote an item only when a concrete application need justifies its added configuration, latency, or operational state. Each item needs its own acceptance criteria and review; none should weaken the v1 identity boundaries, tool independence, or transparent model behavior.
