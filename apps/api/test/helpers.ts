import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, reconcile, resetDatabase, users, type DbHandle } from '@wallet/db';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

export interface Harness {
  app: FastifyInstance;
  handle: DbHandle;
  redis: Redis;
}

export interface TestUser {
  token: string;
  refreshToken: string;
  userId: string;
  accountId: string;
  displayName: string;
}

let seq = 0;

/** Boots the API against the test database. The ledger is reconciled after every test. */
export function useHarness(): Harness {
  const h = {} as Harness;
  let redisSub: Redis;

  beforeAll(async () => {
    const config = loadConfig();
    h.handle = createDb(config.DATABASE_URL, { max: 60 });
    h.redis = new Redis(config.REDIS_URL);
    redisSub = new Redis(config.REDIS_URL);
    h.app = await buildApp({ config, db: h.handle.db, redis: h.redis, redisSub, logger: false });
    await h.app.ready();
  });

  beforeEach(async () => {
    await resetDatabase(h.handle.db);
  });

  afterEach(async () => {
    const report = await reconcile(h.handle.db);
    expect(report, 'ledger must reconcile after every test').toMatchObject({ ok: true });
  });

  afterAll(async () => {
    await h.app.close();
    await h.handle.close();
    h.redis.disconnect();
    redisSub.disconnect();
  });

  return h;
}

export async function registerUser(
  h: Harness,
  name = `User ${seq + 1}`,
  role?: 'admin',
): Promise<TestUser> {
  const n = ++seq;
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `user${n}-${randomUUID().slice(0, 6)}@example.co.za`,
      phone: `+277${String(n).padStart(8, '0')}`,
      displayName: name,
      password: 'password123',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  let token = body.accessToken as string;
  if (role === 'admin') {
    await h.handle.db.update(users).set({ role: 'admin' }).where(eq(users.id, body.user.id));
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: body.user.email, password: 'password123' },
    });
    token = login.json().accessToken;
  }
  const wallet = await h.app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(token) });
  return {
    token,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    accountId: wallet.json().accountId,
    displayName: name,
  };
}

export const auth = (token: string, idempotencyKey?: string) => ({
  authorization: `Bearer ${token}`,
  ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
});

export const key = () => randomUUID();

export async function topUp(app: FastifyInstance, user: TestUser, amountCents: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/topups',
    headers: auth(user.token, key()),
    payload: { amountCents },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

export async function balanceOf(app: FastifyInstance, user: TestUser): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(user.token) });
  return res.json().balanceCents;
}
