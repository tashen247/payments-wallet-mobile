# 4. Ordered `FOR NO KEY UPDATE` locks

**Status:** accepted

## Context

Two concurrent sends from one account can each read the balance and both succeed, overdrawing it. Locking both accounts fixes that, but A→B and B→A running at the same time can deadlock if each locks its own sender first.

## Decision

The posting transaction locks both accounts in **ascending account-ID order**, whichever is sender or recipient. The balance, frozen and daily-limit checks run **after** the locks are taken.

The lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`. The transaction row is inserted first, and its foreign keys take `FOR KEY SHARE` on both accounts. `FOR UPDATE` conflicts with `KEY SHARE`, so two concurrent postings on the same pair each waited on the other's share lock and Postgres killed one as a deadlock. The concurrency tests caught this. `FOR NO KEY UPDATE` doesn't conflict with `KEY SHARE`, still excludes other postings, and is the lock a plain `UPDATE` of a non-key column takes anyway.

Freezing an account takes the same lock, so a freeze waits for in-flight transfers and blocks the ones after it.

## Consequences

Tested: 50 concurrent sends never overdraw, 25 A→B and 25 B→A at once complete without deadlock, and concurrent sends can't jointly exceed the daily limit.
