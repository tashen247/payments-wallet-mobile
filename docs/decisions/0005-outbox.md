# 5. Transactional outbox, at-least-once delivery, per-side-effect de-duplication

**Status:** accepted

## Context

Publishing to a queue after the database commits can lose the event if the process dies in between. Publishing before the commit can announce a transfer that then rolls back.

## Decision

The posting transaction inserts an `outbox_events` row alongside the ledger entries. A relay in the worker claims pending rows with `FOR UPDATE SKIP LOCKED`, so several relays can run at once, publishes them to SQS, and marks them `sent`. If SQS is unreachable, the rows stay `pending` and are retried.

Delivery is therefore **at-least-once**. The consumer de-duplicates per event **and per side effect** (`processed_events (event_id, handler)`, with handlers `ws` and `push`). It inserts the row first, inside a transaction held open while the side effect runs. A concurrent duplicate blocks on the primary key and then skips. A failure rolls the row back, so the retry runs that side effect again.

## Consequences

- A replay never sends a second push. If the WebSocket update succeeded and the push failed, the retry re-runs only the push.
- A crash after the push is sent but before the commit can still duplicate one push. That is the irreducible at-least-once window. Narrowing it needs provider-side idempotency.
