import { eq } from 'drizzle-orm';
import type { DbOrTx } from './client';
import { accounts } from './schema';

/** Counter-account for simulated card top-ups. It goes negative as users are funded. */
export const CARD_FUNDING = 'CARD_FUNDING';
export const SYSTEM_ACCOUNT_CODES = [CARD_FUNDING] as const;

export async function ensureSystemAccounts(db: DbOrTx): Promise<void> {
  for (const code of SYSTEM_ACCOUNT_CODES) {
    await db.insert(accounts).values({ type: 'system', code }).onConflictDoNothing();
  }
}

export async function getSystemAccountId(db: DbOrTx, code: string): Promise<string> {
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code));
  if (!row) throw new Error(`System account ${code} missing; run migrations and seed`);
  return row.id;
}
