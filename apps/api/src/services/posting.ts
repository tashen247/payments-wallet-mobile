import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@wallet/db';
import {
  DAILY_SEND_LIMIT_CENTS,
  type OutboxEventType,
  type OutboxPayload,
  type PostingFailureCode,
} from '@wallet/shared';
import { AppError } from '../lib/errors';

export type PostingKind = 'topup' | 'transfer' | 'request_payment';

export interface PostingInput {
  kind: PostingKind;
  /** Initiating user; idempotency keys are scoped to this user. */
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  reference: string;
  paymentRequestId?: string;
  correlationId?: string | null;
  /** Builds the outbox event written in the same database transaction when the posting completes. */
  outbox?: (tx: TransactionRow) => { type: OutboxEventType; payload: OutboxPayload } | null;
}

export interface TransactionRow {
  id: string;
  type: PostingKind;
  status: 'pending' | 'completed' | 'failed';
  user_id: string;
  idempotency_key: string;
  request_hash: string;
  from_account_id: string;
  to_account_id: string;
  amount_cents: number;
  reference: string;
  payment_request_id: string | null;
  failure_code: PostingFailureCode | null;
  correlation_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface PostingResult {
  transaction: TransactionRow;
  /** True when this call returned an earlier result for the same Idempotency-Key. */
  replayed: boolean;
}

interface LockedAccount {
  id: string;
  type: 'user' | 'system';
  frozen: boolean;
  balance_cents: number;
}

/** Counts towards the daily limit: money a user sends to another user. */
const LIMITED_KINDS: PostingKind[] = ['transfer', 'request_payment'];

function normalise(row: Record<string, unknown>): TransactionRow {
  return { ...(row as unknown as TransactionRow), amount_cents: Number(row.amount_cents) };
}

/**
 * Posts a money movement. Everything happens in one database transaction:
 *
 * 1. Insert the transaction row. The unique (user_id, idempotency_key) index makes a concurrent
 *    duplicate wait for the first insert to commit, then we return the first result.
 * 2. Lock both accounts in ascending id order, so A->B and B->A running at the same time can
 *    never deadlock. The lock is FOR NO KEY UPDATE rather than FOR UPDATE: step 1's foreign keys
 *    already hold FOR KEY SHARE on both accounts, and FOR UPDATE conflicts with KEY SHARE, so two
 *    concurrent postings would each wait on the other's share lock. NO KEY UPDATE still excludes
 *    other postings (it conflicts with itself) and is the lock a plain UPDATE takes anyway.
 * 3. With the locks held, check frozen, balance and the daily limit. Running the checks after the
 *    locks means concurrent requests cannot race past them.
 * 4. For a request payment, move the request from pending to paid with a conditional update.
 * 5. Write one debit and one credit, update both balance projections, complete the transaction
 *    and write the outbox event.
 *
 * A failed check records the transaction as failed (no ledger entries), so a retry with the same
 * key returns the same failure instead of trying again.
 */
export async function post(db: Db, input: PostingInput): Promise<PostingResult> {
  return db.transaction(async (tx) => {
    const inserted = await tx.execute(sql`
      INSERT INTO transactions (type, status, user_id, idempotency_key, request_hash, from_account_id,
        to_account_id, amount_cents, reference, payment_request_id, correlation_id)
      VALUES (${input.kind}, 'pending', ${input.userId}, ${input.idempotencyKey}, ${input.requestHash},
        ${input.fromAccountId}, ${input.toAccountId}, ${input.amountCents}, ${input.reference},
        ${input.paymentRequestId ?? null}, ${input.correlationId ?? null})
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
      RETURNING *`);

    if (inserted.rows.length === 0) {
      const existing = await tx.execute(sql`
        SELECT * FROM transactions WHERE user_id = ${input.userId} AND idempotency_key = ${input.idempotencyKey}`);
      const row = existing.rows[0];
      if (!row) throw new AppError(409, 'INTERNAL', 'Idempotent request still in flight; retry');
      const transaction = normalise(row);
      if (transaction.request_hash !== input.requestHash) {
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', undefined, {
          transactionId: transaction.id,
        });
      }
      return { transaction, replayed: true };
    }

    const transaction = normalise(inserted.rows[0]!);
    const failure = await lockAndCheck(tx, input);
    if (failure) {
      const failed = await tx.execute(sql`
        UPDATE transactions SET status = 'failed', failure_code = ${failure}, completed_at = now()
        WHERE id = ${transaction.id} RETURNING *`);
      return { transaction: normalise(failed.rows[0]!), replayed: false };
    }

    if (input.kind === 'request_payment') {
      const updated = await tx.execute(sql`
        UPDATE payment_requests SET status = 'paid', transaction_id = ${transaction.id}, updated_at = now()
        WHERE id = ${input.paymentRequestId ?? null} AND to_user_id = ${input.userId} AND status = 'pending'
        RETURNING id`);
      if (updated.rows.length === 0) {
        const failed = await tx.execute(sql`
          UPDATE transactions SET status = 'failed', failure_code = 'REQUEST_NOT_PENDING', completed_at = now()
          WHERE id = ${transaction.id} RETURNING *`);
        return { transaction: normalise(failed.rows[0]!), replayed: false };
      }
    }

    await tx.execute(sql`
      INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_cents) VALUES
        (${transaction.id}, ${input.fromAccountId}, 'debit', ${input.amountCents}),
        (${transaction.id}, ${input.toAccountId}, 'credit', ${input.amountCents})`);
    await tx.execute(sql`
      UPDATE accounts SET balance_cents = balance_cents - ${input.amountCents} WHERE id = ${input.fromAccountId}`);
    await tx.execute(sql`
      UPDATE accounts SET balance_cents = balance_cents + ${input.amountCents} WHERE id = ${input.toAccountId}`);
    const completed = await tx.execute(sql`
      UPDATE transactions SET status = 'completed', completed_at = now() WHERE id = ${transaction.id} RETURNING *`);
    const done = normalise(completed.rows[0]!);

    const event = input.outbox?.(done);
    if (event) await writeOutbox(tx, event.type, event.payload, input.correlationId ?? null);
    return { transaction: done, replayed: false };
  });
}

async function lockAndCheck(tx: Tx, input: PostingInput): Promise<PostingFailureCode | null> {
  if (input.fromAccountId === input.toAccountId) return 'SELF_TRANSFER';

  // Lock in a global order (ascending id), whichever side is sender or recipient.
  const order = [input.fromAccountId, input.toAccountId].sort();
  const locked = new Map<string, LockedAccount>();
  for (const accountId of order) {
    const res = await tx.execute(sql`
      SELECT id, type, frozen, balance_cents FROM accounts WHERE id = ${accountId} FOR NO KEY UPDATE`);
    const row = res.rows[0];
    if (!row) throw new AppError(404, 'RECIPIENT_NOT_FOUND');
    locked.set(accountId, {
      ...(row as unknown as LockedAccount),
      balance_cents: Number(row.balance_cents),
    });
  }

  const from = locked.get(input.fromAccountId)!;
  const to = locked.get(input.toAccountId)!;
  if (from.frozen || to.frozen) return 'ACCOUNT_FROZEN';
  if (from.type === 'user' && from.balance_cents < input.amountCents) return 'INSUFFICIENT_FUNDS';

  if (LIMITED_KINDS.includes(input.kind)) {
    const sentToday = await sentTodayCents(tx, input.fromAccountId);
    if (sentToday + input.amountCents > DAILY_SEND_LIMIT_CENTS) return 'DAILY_LIMIT_EXCEEDED';
  }
  return null;
}

/** Start of the current calendar day in South Africa (SAST, UTC+2), as a timestamptz expression. */
export const startOfSastDay = sql`(date_trunc('day', now() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg')`;

export async function sentTodayCents(db: Db | Tx, accountId: string): Promise<number> {
  const res = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
    WHERE from_account_id = ${accountId} AND status = 'completed'
      AND type IN ('transfer', 'request_payment') AND created_at >= ${startOfSastDay}`);
  return Number(res.rows[0]?.total ?? 0);
}

export async function writeOutbox(
  tx: Db | Tx,
  type: OutboxEventType,
  payload: OutboxPayload,
  correlationId: string | null,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO outbox_events (type, payload, correlation_id)
    VALUES (${type}, ${JSON.stringify(payload)}::jsonb, ${correlationId})`);
}
