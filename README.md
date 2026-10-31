# Pay Wallet

[![CI](https://github.com/tashen247/payments-wallet-mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/tashen247/payments-wallet-mobile/actions/workflows/ci.yml)

A production-style mobile wallet for South African rand. Hold a ZAR balance, send money by contact or QR code, request money, and watch your balance update live. Every send is confirmed with Face ID or fingerprint.

The interesting part is the backend: balances come from a **double-entry ledger**, transfers are **idempotent** and **can't overdraw even when they run at the same time**, and side effects go through a **transactional outbox** to a queue, with retries, a dead-letter view and a safe **replay**.

> **Demo:** two phones. Phone A scans phone B's QR code and sends R250 with Face ID. Phone B's balance updates live and it gets a push notification.

## Screenshots

<p>
  <img src="docs/screenshots/home.png" width="260" alt="Wallet home: balance, quick actions and recent transactions" />
  <img src="docs/screenshots/unlock-pin.png" width="260" alt="Wallet locked: app PIN fallback when Face ID is unavailable" />
  <img src="docs/screenshots/confirm-pin.png" width="260" alt="Confirming a R250 send to Sipho with the app PIN" />
  <img src="docs/screenshots/payment-sent.png" width="260" alt="Payment sent: R250 to Sipho Dlamini" />
  <img src="docs/screenshots/received.png" width="260" alt="Sipho's wallet after receiving R250 from Thandi" />
  <img src="docs/screenshots/transaction-detail.png" width="260" alt="Transaction detail with its status timeline" />
  <img src="docs/screenshots/history.png" width="260" alt="History with filters and reference search" />
</p>

## Architecture

```mermaid
flowchart LR
  subgraph Phones
    A[Expo app<br/>phone A]
    B[Expo app<br/>phone B]
  end
  A -- REST + Idempotency-Key --> API
  B <-- WebSocket /v1/ws --> API
  subgraph Backend
    API[Fastify API]
    PG[(PostgreSQL<br/>ledger + outbox)]
    R[(Redis<br/>rate limits, pub/sub)]
    W[Worker<br/>relay + consumer]
    Q[[SQS queue]]
    DLQ[[SQS DLQ]]
  end
  API -- one DB transaction:<br/>ledger entries + outbox row --> PG
  W -- claim pending rows<br/>FOR UPDATE SKIP LOCKED --> PG
  W -- publish --> Q
  Q -- consume --> W
  Q -. redrive .-> DLQ
  W -- live update --> R
  R -- pub/sub fan-out --> API
  W -- push --> Expo[Expo push service]
  Expo --> B
```

1. The API posts a transfer in **one database transaction**: it inserts the transaction, writes a debit and a credit, updates both balance projections, and writes an **outbox event**.
2. The worker's **relay** claims pending outbox rows and publishes them to SQS. If SQS is down, the rows wait in Postgres, so nothing is lost.
3. The worker's **consumer** sends the WebSocket update (through Redis pub/sub, so any API instance can deliver it) and the push notification. Each side effect is recorded in `processed_events`, so a duplicate delivery or a replay never repeats it.
4. After 5 failed attempts with exponential backoff, the event is marked **dead**. Admins see it in the app and can replay it.

## Design decisions

**Double-entry ledger.** Every movement writes exactly one debit and one credit for the same amount. Top-ups debit a `CARD_FUNDING` system account, so they balance too. `ledger_entries` is append-only: a database trigger rejects `UPDATE` and `DELETE`.

**Balance as a projection.** `accounts.balance_cents` is written only by the posting service, in the same transaction as the ledger entries. A reconciliation check (`packages/db/src/reconcile.ts`) proves that every projection equals its ledger sum and every transaction balances. It runs after **every integration test** and is available to admins at `GET /v1/admin/reconciliation`.

**Concurrency: ordered `FOR NO KEY UPDATE` locks.** Both accounts are locked in ascending ID order, so A→B and B→A running at once can't deadlock. The balance, frozen and daily-limit checks run while the locks are held, so concurrent requests can't race past them. The lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`. Inserting the transaction row takes `FOR KEY SHARE` on both accounts through its foreign keys, and `FOR UPDATE` conflicts with that share lock, so two concurrent postings deadlock. The test suite found this. `FOR NO KEY UPDATE` still excludes other postings.

**Idempotency.** Every money-moving endpoint requires an `Idempotency-Key`, unique per user (`UNIQUE (user_id, idempotency_key)`):

- **Same key and same body:** you get the original result back. The response has an `idempotent-replayed: true` header, and the account is never debited a second time.
- **Same key and a different body:** `422 IDEMPOTENCY_KEY_REUSED`.
- **Same key arriving concurrently:** the unique index makes the second insert wait for the first to commit, and then it returns the first result.
- **Failures:** business failures (insufficient funds, limit, frozen) are stored on the transaction. A retry returns the same failure instead of trying again.

The app keeps one key per user action and reuses it when retrying after a network error.

**Outbox and at-least-once delivery.** The outbox row commits with the money, so an event can't be lost or sent for a transfer that rolled back. Delivery is at-least-once, and the consumer de-duplicates per event and per side effect. It inserts the `processed_events` row first, inside a transaction that stays open while the side effect runs. A concurrent duplicate blocks on the primary key and then skips. If the side effect fails, the row rolls back and the retry runs it again.

**One place for dead letters.** The worker marks events `dead` in the outbox table, which is what the admin screen reads. The SQS DLQ is only a safety net for messages the worker couldn't parse, and those are written back to the outbox as dead too.

**Daily limit.** R5 000 per calendar day in Africa/Johannesburg time. Transfers and request payments count towards it; top-ups don't.

## Running locally

Requirements: Node 20+, pnpm 10, Docker.

```bash
pnpm install
docker compose up -d          # Postgres, Redis, LocalStack (SQS)
pnpm db:migrate
pnpm db:seed                  # demo users and a few hundred transactions
pnpm dev:backend              # API on :3000 and the worker
```

- API docs (OpenAPI generated from the Zod schemas): http://localhost:3000/docs
- No LocalStack? Run the worker with `QUEUE_DRIVER=memory`.

### Demo logins

The password for all of them is `Demo1234!`.

| User                          | Email             |
| ----------------------------- | ----------------- |
| Thandi Nkosi (wallet holder)  | thandi@demo.co.za |
| Sipho Dlamini (wallet holder) | sipho@demo.co.za  |
| Operations (admin)            | ops@demo.co.za    |

### Forcing a dead letter for the demo

```bash
WORKER_FAIL_EVENT_TYPES=transfer.completed pnpm --filter @wallet/worker dev
# send money: after 5 attempts the event shows in Admin → Dead letters
# restart the worker without the variable, then press Replay: exactly one notification arrives
```

## Running the app on two phones

The app uses Face ID and push notifications, which Expo Go does not support, so it runs as an **Expo development build**.

1. **Point the app at your machine.** Phones can't reach `localhost`. Find your LAN IP (`ipconfig` on Windows, `ipconfig getifaddr en0` on macOS) and create `apps/mobile/.env`:
   ```
   EXPO_PUBLIC_API_URL=http://192.168.1.20:3000
   ```
   The API listens on `0.0.0.0` in development. If your Wi-Fi blocks device-to-device traffic, use a tunnel instead.
2. **Push notifications (optional).** Run `npx eas init` in `apps/mobile` and set `EAS_PROJECT_ID`. Push needs physical devices; everything else works on simulators.
3. **Build and run** on each phone:
   ```bash
   cd apps/mobile
   npx expo run:android   # or: npx expo run:ios
   # or a cloud build: npx eas build --profile development
   pnpm dev               # Metro for the dev client
   ```
4. **The demo.** Log in as Thandi on phone A and as Sipho on phone B. On B, open **My QR**. On A, tap **Send → Scan QR code**, enter R250 and confirm with Face ID. B's balance updates live and B gets a push notification.

### What's in the app

- Email and password login, with tokens in SecureStore and refresh-token rotation
- Biometric unlock on open and after a minute in the background, with a 4-digit app PIN fallback
- Biometric confirmation before **every** send and every request payment
- Home: balance, the last 5 transactions, and Send, Request and Top up
- Send by contact search or by scanning a QR code. A scanned code only pre-fills the form: the recipient's name is looked up and shown, and the sender confirms the amount.
- A receive QR code (`paywallet://pay?to=<accountId>`), which also works as a deep link
- History with infinite scroll, sent/received/top-up filters, reference search, and a detail screen with a status timeline
- Payment requests you can pay or decline
- Live balance over a WebSocket that reconnects with backoff, and push notifications in the background
- Role-gated admin screens: transfers by status, dead letters with Replay, and freezing accounts
- Dark mode, accessible labels, loading, empty and error states, and haptics on success

## Deploying to AWS

`infra/` is an AWS CDK app:

- a VPC
- RDS Postgres 16 (encrypted, private subnets)
- ElastiCache Redis
- an SQS queue with a DLQ
- the API on ECS Fargate behind an ALB, with a `/health` check and a 300-second idle timeout for WebSockets
- the worker as a second Fargate service

Credentials come from Secrets Manager, never plain environment variables.

```bash
pnpm synth                         # runs in CI
cd infra && npx cdk deploy         # needs AWS credentials
```

The API container runs migrations before it starts.

## Tests

```bash
pnpm test
```

The integration tests run against a real Postgres and Redis. They include:

- 50 concurrent transfers from one account, which never overdraw it
- 25 A→B and 25 B→A transfers at once, with no deadlocks
- 20 concurrent sends that together can't exceed the daily limit
- the same `Idempotency-Key` fired 10 times at once, which produces exactly one posting
- a request paid concurrently with different keys, which is paid once
- a freeze racing in-flight transfers
- retries, backoff, dead-lettering, and a replay that produces no duplicate push
- the full demo flow end to end: API, worker, WebSocket and push

The app has Jest and React Native Testing Library tests for the send flow (biometric confirm and decline, retrying with the same Idempotency-Key, declined payments), the history list (pagination, filters, empty state) and live-update handling.

CI runs lint, typecheck, all tests with coverage (70% minimum on the API, worker and shared packages), the 10,000-transaction latency check, and `cdk synth`.

### Performance

With 10,000 seeded transactions, run the latency check:

```bash
SEED_TRANSACTIONS=10000 pnpm db:seed
pnpm --filter @wallet/api bench
```

The target is p95 under 200 ms. Locally it measures about 10 ms for creating a transfer and about 6 ms for a page of history.

## Repo layout

```
apps/api        Fastify API: auth, wallet, transfers, payment requests, admin, WebSocket
apps/worker     Outbox relay, SQS consumer, push sender, dead letters
apps/mobile     Expo app (React Native)
packages/shared Zod schemas, money helpers, QR receive-code format (shared by app and API)
packages/db     Drizzle schema, migrations, reconciliation
infra           AWS CDK: ECS Fargate, RDS, ElastiCache, SQS + DLQ
docs/decisions  ADRs
```

## Decision records

1. [Double-entry ledger with system accounts](docs/decisions/0001-double-entry-ledger.md)
2. [Balance as a projection, with reconciliation](docs/decisions/0002-balance-projection.md)
3. [Idempotency rules](docs/decisions/0003-idempotency.md)
4. [Ordered FOR NO KEY UPDATE locks](docs/decisions/0004-lock-ordering.md)
5. [Transactional outbox and de-duplication](docs/decisions/0005-outbox.md)
6. [One store for dead letters](docs/decisions/0006-dead-letters.md)

## Licence

MIT
