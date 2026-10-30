import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client';

export interface ReconciliationReport {
  ok: boolean;
  /** Accounts whose balance projection does not equal the ledger sum. */
  projectionMismatches: { accountId: string; balanceCents: number; ledgerCents: number }[];
  /** Transactions whose debits do not equal their credits. */
  unbalancedTransactions: { transactionId: string; debits: number; credits: number }[];
  /** Completed transactions without exactly one debit and one credit. */
  incompletePostings: string[];
  /** Ledger entries attached to transactions that are not completed. */
  entriesOnNonCompleted: string[];
  totalDebits: number;
  totalCredits: number;
}

/**
 * Proves the ledger invariants. Run after every integration test, and exposed to admins as a health check.
 */
export async function reconcile(db: DbOrTx): Promise<ReconciliationReport> {
  const mismatches = await db.execute<{
    account_id: string;
    balance_cents: string;
    ledger_cents: string;
  }>(sql`
    SELECT a.id AS account_id, a.balance_cents, COALESCE(SUM(
      CASE WHEN l.direction = 'credit' THEN l.amount_cents ELSE -l.amount_cents END), 0) AS ledger_cents
    FROM accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
    GROUP BY a.id, a.balance_cents
    HAVING a.balance_cents <> COALESCE(SUM(
      CASE WHEN l.direction = 'credit' THEN l.amount_cents ELSE -l.amount_cents END), 0)
  `);
  const unbalanced = await db.execute<{
    transaction_id: string;
    debits: string;
    credits: string;
  }>(sql`
    SELECT transaction_id,
      SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE 0 END) AS debits,
      SUM(CASE WHEN direction = 'credit' THEN amount_cents ELSE 0 END) AS credits
    FROM ledger_entries GROUP BY transaction_id
    HAVING SUM(CASE WHEN direction = 'debit' THEN amount_cents ELSE -amount_cents END) <> 0
  `);
  const incomplete = await db.execute<{ id: string }>(sql`
    SELECT t.id FROM transactions t
    WHERE t.status = 'completed' AND (
      (SELECT COUNT(*) FROM ledger_entries l WHERE l.transaction_id = t.id AND l.direction = 'debit' AND l.account_id = t.from_account_id AND l.amount_cents = t.amount_cents) <> 1 OR
      (SELECT COUNT(*) FROM ledger_entries l WHERE l.transaction_id = t.id AND l.direction = 'credit' AND l.account_id = t.to_account_id AND l.amount_cents = t.amount_cents) <> 1 OR
      (SELECT COUNT(*) FROM ledger_entries l WHERE l.transaction_id = t.id) <> 2)
  `);
  const onNonCompleted = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT l.transaction_id AS id FROM ledger_entries l
    JOIN transactions t ON t.id = l.transaction_id WHERE t.status <> 'completed'
  `);
  const totals = await db.execute<{ debits: string; credits: string }>(sql`
    SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_cents END), 0) AS debits,
           COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cents END), 0) AS credits
    FROM ledger_entries
  `);
  const totalDebits = Number(totals.rows[0]?.debits ?? 0);
  const totalCredits = Number(totals.rows[0]?.credits ?? 0);
  const report: ReconciliationReport = {
    projectionMismatches: mismatches.rows.map((r) => ({
      accountId: r.account_id,
      balanceCents: Number(r.balance_cents),
      ledgerCents: Number(r.ledger_cents),
    })),
    unbalancedTransactions: unbalanced.rows.map((r) => ({
      transactionId: r.transaction_id,
      debits: Number(r.debits),
      credits: Number(r.credits),
    })),
    incompletePostings: incomplete.rows.map((r) => r.id),
    entriesOnNonCompleted: onNonCompleted.rows.map((r) => r.id),
    totalDebits,
    totalCredits,
    ok: false,
  };
  report.ok =
    report.projectionMismatches.length === 0 &&
    report.unbalancedTransactions.length === 0 &&
    report.incompletePostings.length === 0 &&
    report.entriesOnNonCompleted.length === 0 &&
    totalDebits === totalCredits;
  return report;
}
