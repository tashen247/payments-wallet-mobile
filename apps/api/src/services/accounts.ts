import { and, eq, ilike, ne, or } from 'drizzle-orm';
import { accounts, users, type Db } from '@wallet/db';
import type { ContactDto } from '@wallet/shared';

export async function getUserAccount(db: Db, userId: string) {
  const [row] = await db.select().from(accounts).where(eq(accounts.userId, userId));
  if (!row) throw new Error(`User ${userId} has no account`);
  return row;
}

/** Resolve a user account id to its owner (used for QR codes and request targets). */
export async function findUserByAccountId(db: Db, accountId: string) {
  const [row] = await db
    .select({
      accountId: accounts.id,
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      phone: users.phone,
    })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(and(eq(accounts.id, accountId), eq(accounts.type, 'user')));
  return row ?? null;
}

export async function searchContacts(db: Db, userId: string, q: string): Promise<ContactDto[]> {
  const term = q.trim();
  const digits = term.replace(/\D/g, '');
  const phoneTerm = digits.startsWith('0') ? `+27${digits.slice(1)}` : digits;
  const conditions = [ilike(users.email, `${term}%`), ilike(users.displayName, `%${term}%`)];
  if (digits.length >= 4) conditions.push(ilike(users.phone, `%${phoneTerm}%`));
  return db
    .select({
      accountId: accounts.id,
      displayName: users.displayName,
      email: users.email,
      phone: users.phone,
    })
    .from(users)
    .innerJoin(accounts, eq(accounts.userId, users.id))
    .where(and(ne(users.id, userId), eq(users.role, 'holder'), or(...conditions)))
    .orderBy(users.displayName)
    .limit(10);
}
