import { sql } from 'drizzle-orm';
import type { Db } from '@wallet/db';
import { formatCents, type PaymentRequestDto } from '@wallet/shared';
import { AppError } from '../lib/errors';
import { requestHash } from '../lib/idempotency';
import { findUserByAccountId, getUserAccount } from './accounts';
import { getTransactionForAccount } from './history';
import { post, writeOutbox } from './posting';
import type { MoneyContext, MoneyResult } from './money';
import { statusForFailure } from '../lib/errors';

type Row = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  amount_cents: string;
  reference: string;
  status: PaymentRequestDto['status'];
  created_at: Date;
  from_name: string;
  to_name: string;
  from_account_id: string;
  to_account_id: string;
};

const select = sql`
  SELECT r.*, fu.display_name AS from_name, tu.display_name AS to_name,
    fa.id AS from_account_id, ta.id AS to_account_id
  FROM payment_requests r
  JOIN users fu ON fu.id = r.from_user_id JOIN accounts fa ON fa.user_id = r.from_user_id
  JOIN users tu ON tu.id = r.to_user_id JOIN accounts ta ON ta.user_id = r.to_user_id`;

function toDto(row: Row, userId: string): PaymentRequestDto {
  const incoming = row.to_user_id === userId;
  return {
    id: row.id,
    direction: incoming ? 'incoming' : 'outgoing',
    amountCents: Number(row.amount_cents),
    reference: row.reference,
    status: row.status,
    counterparty: incoming
      ? { accountId: row.from_account_id, displayName: row.from_name }
      : { accountId: row.to_account_id, displayName: row.to_name },
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function load(db: Db, id: string, userId: string): Promise<Row> {
  const res = await db.execute<Row>(
    sql`${select} WHERE r.id = ${id} AND (r.from_user_id = ${userId} OR r.to_user_id = ${userId})`,
  );
  const row = res.rows[0];
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return row;
}

export async function createRequest(
  db: Db,
  ctx: { userId: string; displayName: string; correlationId: string },
  body: { toAccountId: string; amountCents: number; reference: string },
): Promise<PaymentRequestDto> {
  const payer = await findUserByAccountId(db, body.toAccountId);
  if (!payer) throw new AppError(404, 'RECIPIENT_NOT_FOUND');
  if (payer.userId === ctx.userId)
    throw new AppError(422, 'SELF_TRANSFER', 'You cannot request money from yourself.');
  const id = await db.transaction(async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      INSERT INTO payment_requests (from_user_id, to_user_id, amount_cents, reference)
      VALUES (${ctx.userId}, ${payer.userId}, ${body.amountCents}, ${body.reference}) RETURNING id`);
    const requestId = res.rows[0]!.id;
    await writeOutbox(
      tx,
      'payment_request.created',
      {
        paymentRequestId: requestId,
        amountCents: body.amountCents,
        targets: [
          {
            userId: payer.userId,
            push: {
              title: `${ctx.displayName} requested ${formatCents(body.amountCents)}`,
              body: body.reference || 'Tap to pay or decline',
            },
          },
        ],
      },
      ctx.correlationId,
    );
    return requestId;
  });
  return toDto(await load(db, id, ctx.userId), ctx.userId);
}

export async function listRequests(db: Db, userId: string): Promise<PaymentRequestDto[]> {
  const res = await db.execute<Row>(sql`${select}
    WHERE r.from_user_id = ${userId} OR r.to_user_id = ${userId}
    ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 100`);
  return res.rows.map((r) => toDto(r, userId));
}

/** Pays an incoming request through the posting service: same locks, limits and idempotency as a transfer. */
export async function payRequest(
  db: Db,
  ctx: MoneyContext,
  requestId: string,
): Promise<MoneyResult> {
  const row = await load(db, requestId, ctx.userId);
  if (row.to_user_id !== ctx.userId) throw new AppError(404, 'NOT_FOUND');
  const account = await getUserAccount(db, ctx.userId);
  const amountCents = Number(row.amount_cents);
  const result = await post(db, {
    kind: 'request_payment',
    userId: ctx.userId,
    idempotencyKey: ctx.idempotencyKey,
    requestHash: requestHash('request_payment', { requestId }),
    fromAccountId: account.id,
    toAccountId: row.from_account_id,
    amountCents,
    reference: row.reference,
    paymentRequestId: requestId,
    correlationId: ctx.correlationId,
    outbox: (tx) => ({
      type: 'transfer.completed',
      payload: {
        transactionId: tx.id,
        paymentRequestId: requestId,
        amountCents,
        targets: [
          {
            userId: row.from_user_id,
            push: {
              title: `${ctx.displayName} paid your request`,
              body: `${formatCents(amountCents)}${row.reference ? ` · ${row.reference}` : ''}`,
            },
          },
          { userId: ctx.userId, push: null },
        ],
      },
    }),
  });
  const transaction = await getTransactionForAccount(db, account.id, result.transaction.id);
  const failure = result.transaction.failure_code;
  if (failure)
    throw new AppError(statusForFailure(failure), failure, undefined, {
      transaction,
      replayed: result.replayed,
    });
  return { statusCode: 201, replayed: result.replayed, transaction };
}

export async function declineRequest(
  db: Db,
  ctx: { userId: string; displayName: string; correlationId: string },
  requestId: string,
): Promise<PaymentRequestDto> {
  const row = await load(db, requestId, ctx.userId);
  if (row.to_user_id !== ctx.userId) throw new AppError(404, 'NOT_FOUND');
  await db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      UPDATE payment_requests SET status = 'declined', updated_at = now()
      WHERE id = ${requestId} AND to_user_id = ${ctx.userId} AND status = 'pending' RETURNING id`);
    if (res.rows.length === 0) throw new AppError(409, 'REQUEST_NOT_PENDING');
    await writeOutbox(
      tx,
      'payment_request.declined',
      {
        paymentRequestId: requestId,
        amountCents: Number(row.amount_cents),
        targets: [
          {
            userId: row.from_user_id,
            push: {
              title: `${ctx.displayName} declined your request`,
              body: formatCents(Number(row.amount_cents)),
            },
          },
        ],
      },
      ctx.correlationId,
    );
  });
  return toDto(await load(db, requestId, ctx.userId), ctx.userId);
}

export { getUserAccount };
