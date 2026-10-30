import { and, eq, isNull } from 'drizzle-orm';
import { accounts, refreshTokens, users, type Db } from '@wallet/db';
import type { UserDto } from '@wallet/shared';
import { AppError } from '../lib/errors';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/password';

type UserRow = typeof users.$inferSelect;

export const toUserDto = (u: UserRow): UserDto => ({
  id: u.id,
  email: u.email,
  phone: u.phone,
  displayName: u.displayName,
  role: u.role,
});

export async function register(
  db: Db,
  input: {
    email: string;
    phone: string;
    displayName: string;
    password: string;
    role?: 'holder' | 'admin';
  },
): Promise<UserRow> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          phone: input.phone,
          displayName: input.displayName,
          passwordHash,
          role: input.role ?? 'holder',
        })
        .returning();
      await tx.insert(accounts).values({ type: 'user', userId: user!.id });
      return user!;
    });
  } catch (err) {
    if (
      (err as { cause?: { code?: string } }).cause?.code === '23505' ||
      (err as { code?: string }).code === '23505'
    ) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email or phone already exists.');
    }
    throw err;
  }
}

export async function login(db: Db, email: string, password: string): Promise<UserRow> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  // Hash anyway on unknown email so response time does not reveal which emails exist.
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : (await hashPassword(password), false);
  if (!user || !ok || user.status !== 'active') throw new AppError(401, 'INVALID_CREDENTIALS');
  return user;
}

export async function issueRefreshToken(
  db: Db,
  userId: string,
  ttlDays: number,
): Promise<{ token: string; id: string }> {
  const token = randomToken();
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
    })
    .returning({ id: refreshTokens.id });
  return { token, id: row!.id };
}

/**
 * Rotates a refresh token. Presenting a token that was already rotated means it leaked, so every
 * session for that user is revoked.
 */
export async function rotateRefreshToken(db: Db, presented: string, ttlDays: number) {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, sha256(presented)));
  if (!row || row.expiresAt < new Date()) throw new AppError(401, 'UNAUTHORIZED');
  if (row.revokedAt) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));
    throw new AppError(401, 'UNAUTHORIZED', 'Session expired. Please log in again.');
  }
  const next = await issueRefreshToken(db, row.userId, ttlDays);
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), replacedById: next.id })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  if (revoked.length === 0) throw new AppError(401, 'UNAUTHORIZED');
  const [user] = await db.select().from(users).where(eq(users.id, row.userId));
  return { user: user!, refreshToken: next.token };
}
