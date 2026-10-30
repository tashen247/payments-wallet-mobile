import { sql } from 'drizzle-orm';
import { auditEvents, type Db } from '@wallet/db';
import type { AdminAccountDto, AdminTransactionDto, DeadLetterDto } from '@wallet/shared';
import { AppError } from '../lib/errors';

export async function listTransactions(
  db: Db,
  status: string | undefined,
  limit: number,
): Promise<AdminTransactionDto[]> {
  const res = await db.execute<{
    id: string;
    type: AdminTransactionDto['type'];
    status: AdminTransactionDto['status'];
    amount_cents: string;
    reference: string;
    from_name: string | null;
    to_name: string | null;
    failure_code: string | null;
    created_at: Date;
  }>(sql`
    SELECT t.id, t.type, t.status, t.amount_cents, t.reference, t.failure_code, t.created_at,
      COALESCE(fu.display_name, fa.code) AS from_name, COALESCE(tu.display_name, ta.code) AS to_name
    FROM transactions t
    JOIN accounts fa ON fa.id = t.from_account_id LEFT JOIN users fu ON fu.id = fa.user_id
    JOIN accounts ta ON ta.id = t.to_account_id LEFT JOIN users tu ON tu.id = ta.user_id
    ${status ? sql`WHERE t.status = ${status}` : sql``}
    ORDER BY t.created_at DESC LIMIT ${limit}`);
  return res.rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    amountCents: Number(r.amount_cents),
    reference: r.reference,
    fromName: r.from_name,
    toName: r.to_name,
    failureCode: r.failure_code,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function listDeadLetters(db: Db): Promise<DeadLetterDto[]> {
  const res = await db.execute<{
    id: string;
    type: string;
    attempts: number;
    last_error: string | null;
    created_at: Date;
    correlation_id: string | null;
  }>(sql`
    SELECT id, type, attempts, last_error, created_at, correlation_id FROM outbox_events
    WHERE status = 'dead' ORDER BY dead_at DESC LIMIT 200`);
  return res.rows.map((r) => ({
    id: r.id,
    type: r.type,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: new Date(r.created_at).toISOString(),
    correlationId: r.correlation_id,
  }));
}

/**
 * Puts a dead event back in the outbox. The worker's processed_events check means side effects that
 * already happened are not repeated, so replaying is safe to press twice.
 */
export async function replayDeadLetter(db: Db, actorId: string, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      UPDATE outbox_events SET status = 'pending', attempts = 0, dead_at = NULL
      WHERE id = ${eventId} AND status = 'dead' RETURNING id`);
    if (res.rows.length === 0) throw new AppError(409, 'NOT_DEAD_LETTERED');
    await tx
      .insert(auditEvents)
      .values({ actorId, action: 'dead_letter.replay', targetId: eventId });
  });
}

export async function listAccounts(db: Db, q: string | undefined): Promise<AdminAccountDto[]> {
  const res = await db.execute<{
    account_id: string;
    display_name: string;
    email: string;
    frozen: boolean;
    balance_cents: string;
  }>(sql`
    SELECT a.id AS account_id, u.display_name, u.email, a.frozen, a.balance_cents
    FROM accounts a JOIN users u ON u.id = a.user_id
    WHERE u.role = 'holder' ${q ? sql`AND (u.display_name ILIKE ${'%' + q + '%'} OR u.email ILIKE ${'%' + q + '%'})` : sql``}
    ORDER BY u.display_name LIMIT 100`);
  return res.rows.map((r) => ({
    accountId: r.account_id,
    displayName: r.display_name,
    email: r.email,
    frozen: r.frozen,
    balanceCents: Number(r.balance_cents),
  }));
}

/** Freezing takes the same row lock as postings, so it waits for in-flight transfers on the account. */
export async function setFrozen(
  db: Db,
  actorId: string,
  accountId: string,
  frozen: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`SELECT id FROM accounts WHERE id = ${accountId} AND type = 'user' FOR NO KEY UPDATE`,
    );
    if (res.rows.length === 0) throw new AppError(404, 'NOT_FOUND');
    await tx.execute(sql`UPDATE accounts SET frozen = ${frozen} WHERE id = ${accountId}`);
    await tx
      .insert(auditEvents)
      .values({
        actorId,
        action: frozen ? 'account.freeze' : 'account.unfreeze',
        targetId: accountId,
      });
  });
}
