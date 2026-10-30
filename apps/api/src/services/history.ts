import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@wallet/db';
import type { HistoryPage, TransactionDto } from '@wallet/shared';
import { AppError } from '../lib/errors';

type Row = {
  id: string;
  type: TransactionDto['type'];
  status: TransactionDto['status'];
  from_account_id: string;
  to_account_id: string;
  amount_cents: string;
  reference: string;
  failure_code: string | null;
  created_at: Date;
  created_at_raw: string;
  completed_at: Date | null;
  from_name: string | null;
  to_name: string | null;
};

const select = sql`
  SELECT t.id, t.type, t.status, t.from_account_id, t.to_account_id, t.amount_cents, t.reference,
    t.failure_code, t.created_at, t.created_at::text AS created_at_raw, t.completed_at,
    fu.display_name AS from_name, tu.display_name AS to_name
  FROM transactions t
  JOIN accounts fa ON fa.id = t.from_account_id LEFT JOIN users fu ON fu.id = fa.user_id
  JOIN accounts ta ON ta.id = t.to_account_id LEFT JOIN users tu ON tu.id = ta.user_id`;

function toDto(row: Row, myAccountId: string): TransactionDto {
  const sent = row.type !== 'topup' && row.from_account_id === myAccountId;
  const direction = row.type === 'topup' ? 'topup' : sent ? 'sent' : 'received';
  const counterparty =
    row.type === 'topup'
      ? null
      : sent
        ? { accountId: row.to_account_id, displayName: row.to_name ?? 'Unknown' }
        : { accountId: row.from_account_id, displayName: row.from_name ?? 'Unknown' };
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    direction,
    amountCents: Number(row.amount_cents),
    reference: row.reference,
    counterparty,
    failureCode: row.failure_code,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

/** Visible to me: everything I sent or topped up (any status), plus completed money I received. */
const visibleTo = (accountId: string) =>
  sql`(t.from_account_id = ${accountId} OR (t.to_account_id = ${accountId} AND (t.status = 'completed' OR t.type = 'topup')))`;

const encodeCursor = (row: Row) =>
  Buffer.from(`${row.created_at_raw}|${row.id}`).toString('base64url');
function decodeCursor(cursor: string): { ts: string; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!ts || !id) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid cursor');
  return { ts, id };
}

export async function listHistory(
  db: Db,
  accountId: string,
  query: {
    filter: 'all' | 'sent' | 'received' | 'topup';
    q?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
): Promise<HistoryPage> {
  const where: SQL[] = [sql`t.status <> 'pending'`];
  switch (query.filter) {
    case 'sent':
      where.push(sql`t.from_account_id = ${accountId} AND t.type <> 'topup'`);
      break;
    case 'received':
      where.push(
        sql`t.to_account_id = ${accountId} AND t.type <> 'topup' AND t.status = 'completed'`,
      );
      break;
    case 'topup':
      where.push(sql`t.to_account_id = ${accountId} AND t.type = 'topup'`);
      break;
    default:
      where.push(visibleTo(accountId));
  }
  if (query.q) where.push(sql`t.reference ILIKE ${'%' + query.q.replace(/[%_]/g, '\\$&') + '%'}`);
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    where.push(sql`(t.created_at, t.id) < (${c.ts}::timestamptz, ${c.id}::uuid)`);
  }
  const res = await db.execute<Row>(sql`${select} WHERE ${sql.join(where, sql` AND `)}
    ORDER BY t.created_at DESC, t.id DESC LIMIT ${query.limit + 1}`);
  const rows = res.rows.slice(0, query.limit);
  const hasMore = res.rows.length > query.limit;
  return {
    items: rows.map((r) => toDto(r, accountId)),
    nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]!) : null,
  };
}

export async function getTransactionForAccount(
  db: Db,
  accountId: string,
  id: string,
): Promise<TransactionDto> {
  const res = await db.execute<Row>(sql`${select} WHERE t.id = ${id} AND ${visibleTo(accountId)}`);
  const row = res.rows[0];
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return toDto(row, accountId);
}
