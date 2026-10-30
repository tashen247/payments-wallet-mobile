# 1. Double-entry ledger with system accounts

**Status:** accepted

## Context

A wallet balance that is a single mutable number can drift. Nothing proves where money came from or went, and a bug in one code path silently changes totals.

## Decision

Every money movement is one `transactions` row plus exactly two `ledger_entries`: a debit and a credit of the same amount. Money never appears from nowhere: a simulated card top-up debits a `CARD_FUNDING` **system account** and credits the user. System accounts may go negative. User accounts may not, which is enforced by a check constraint as well as in code.

`ledger_entries` is **append-only**. A trigger rejects `UPDATE` and `DELETE`, so a mistake is corrected with a new, reversing transaction and never by editing history.

## Consequences

- Total debits always equal total credits, and that is checkable at any time (see ADR 2).
- `CARD_FUNDING` is a hot row that every top-up locks. That's fine at demo scale. At real scale it would be split into shards, or not locked at all, because a system account has no balance floor to protect.
