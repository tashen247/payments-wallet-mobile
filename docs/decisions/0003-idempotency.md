# 3. Idempotency rules for money-moving endpoints

**Status:** accepted

## Context

Mobile networks drop responses. An app that retries a `POST /transfers` without protection debits twice.

## Decision

Top-ups, transfers and request payments all require an `Idempotency-Key` header. The database is the source of truth: `UNIQUE (user_id, idempotency_key)` on `transactions`, with a hash of the request stored alongside.

| Case                                    | Result                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Same key, same body                     | The original transaction and status (`idempotent-replayed: true`). Never a second posting.                                 |
| Same key, different body                | `422 IDEMPOTENCY_KEY_REUSED`                                                                                               |
| Same key, concurrent                    | `INSERT ... ON CONFLICT DO NOTHING` waits for the first insert to commit, then the second request returns the first result |
| Business failure (funds, limit, frozen) | Recorded on the transaction as `failed`. A retry returns the same failure.                                                 |

The app generates one key per user action, reuses it for automatic retries on network errors or 5xx responses, and starts a new key only when the user starts a new action.

## Consequences

Tested: the same key fired 10 times at once produces exactly one posting. Redis is not involved in idempotency at all, so there is one source of truth.
