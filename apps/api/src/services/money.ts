import { CARD_FUNDING, getSystemAccountId, type Db } from '@wallet/db';
import { formatCents, type TransactionDto } from '@wallet/shared';
import { AppError, statusForFailure } from '../lib/errors';
import { requestHash } from '../lib/idempotency';
import { findUserByAccountId, getUserAccount } from './accounts';
import { getTransactionForAccount } from './history';
import { post, type PostingResult } from './posting';

export interface MoneyContext {
  userId: string;
  displayName: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface MoneyResult {
  statusCode: number;
  replayed: boolean;
  transaction: TransactionDto;
}

async function finish(db: Db, accountId: string, result: PostingResult): Promise<MoneyResult> {
  const transaction = await getTransactionForAccount(db, accountId, result.transaction.id);
  const failure = result.transaction.failure_code;
  if (failure) {
    throw new AppError(statusForFailure(failure), failure, undefined, {
      transaction,
      replayed: result.replayed,
    });
  }
  return { statusCode: 201, replayed: result.replayed, transaction };
}

export async function topUp(db: Db, ctx: MoneyContext, amountCents: number): Promise<MoneyResult> {
  const account = await getUserAccount(db, ctx.userId);
  const funding = await getSystemAccountId(db, CARD_FUNDING);
  const result = await post(db, {
    kind: 'topup',
    userId: ctx.userId,
    idempotencyKey: ctx.idempotencyKey,
    requestHash: requestHash('topup', { amountCents }),
    fromAccountId: funding,
    toAccountId: account.id,
    amountCents,
    reference: 'Card top-up',
    correlationId: ctx.correlationId,
    outbox: (tx) => ({
      type: 'topup.completed',
      payload: { transactionId: tx.id, amountCents, targets: [{ userId: ctx.userId, push: null }] },
    }),
  });
  return finish(db, account.id, result);
}

export async function transfer(
  db: Db,
  ctx: MoneyContext,
  body: { toAccountId: string; amountCents: number; reference: string },
): Promise<MoneyResult> {
  const account = await getUserAccount(db, ctx.userId);
  const recipient = await findUserByAccountId(db, body.toAccountId);
  if (!recipient) throw new AppError(404, 'RECIPIENT_NOT_FOUND');
  const result = await post(db, {
    kind: 'transfer',
    userId: ctx.userId,
    idempotencyKey: ctx.idempotencyKey,
    requestHash: requestHash('transfer', body),
    fromAccountId: account.id,
    toAccountId: body.toAccountId,
    amountCents: body.amountCents,
    reference: body.reference,
    correlationId: ctx.correlationId,
    outbox: (tx) => ({
      type: 'transfer.completed',
      payload: {
        transactionId: tx.id,
        amountCents: body.amountCents,
        targets: [
          {
            userId: recipient.userId,
            push: {
              title: `You received ${formatCents(body.amountCents)}`,
              body: `From ${ctx.displayName}${body.reference ? ` · ${body.reference}` : ''}`,
            },
          },
          { userId: ctx.userId, push: null },
        ],
      },
    }),
  });
  return finish(db, account.id, result);
}
