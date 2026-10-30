# 6. One store for dead letters

**Status:** accepted

## Context

With SQS there are two candidate dead-letter stores: the SQS DLQ and the outbox table. Two stores means two places to look and two replay paths.

## Decision

The worker retries with exponential backoff (via the visibility timeout) and, after `MAX_ATTEMPTS` (5), marks the event `dead` in `outbox_events` with `last_error` and the attempt count. The admin screen reads **only** that table. Replay resets the row to `pending` (audited) and the normal relay picks it up.

The SQS DLQ (`maxReceiveCount` = attempts + 1) is a safety net for messages the worker could not even parse. A drain loop writes those back to the outbox as `dead`.

For demos and tests, `WORKER_FAIL_EVENT_TYPES=transfer.completed` makes the worker fail those events on purpose.

## Consequences

One screen and one replay path. Replay is safe to press repeatedly because of ADR 5.
