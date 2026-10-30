# 2. Balance as a projection, with reconciliation

**Status:** accepted

## Context

Computing `SUM(ledger_entries)` on every balance read is correct but grows with history. Keeping a cached balance in Redis is fast but can go stale or diverge.

## Decision

`accounts.balance_cents` is a **projection** of the ledger. Only the posting service writes it, in the same database transaction as the ledger entries, under the same row lock. It is never edited directly.

A reconciliation check (`packages/db/src/reconcile.ts`) proves four things:

- every projection equals its ledger sum
- every transaction balances
- every completed transaction has exactly one debit and one credit for its amount
- failed transactions have no entries

It runs after **every integration test**, so a test that leaves the ledger wrong fails the build. It's also exposed at `GET /v1/admin/reconciliation`.

## Consequences

Balance reads are a primary-key lookup. Redis never holds balances.
