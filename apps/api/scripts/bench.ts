/**
 * Local latency check for the PRD target: p95 under 200 ms for transfer creation and history,
 * with 10,000 seeded transactions. Run after `SEED_TRANSACTIONS=10000 pnpm db:seed`.
 *
 *   pnpm --filter @wallet/api bench
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { createDb } from '@wallet/db';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

const config = { ...loadConfig(), RATE_LIMIT_ENABLED: false };
const handle = createDb(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL);
const redisSub = new Redis(config.REDIS_URL);
const app = await buildApp({ config, db: handle.db, redis, redisSub, logger: false });

const count = await handle.db.execute<{ n: number }>(
  sql`SELECT COUNT(*)::int AS n FROM transactions`,
);
console.log(`transactions in database: ${count.rows[0]!.n}`);

const login = async (email: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'Demo1234!' },
    })
  ).json().accessToken as string;
const thandi = await login('thandi@demo.co.za');
const sipho = await login('sipho@demo.co.za');
const siphoAccount = (
  await app.inject({
    method: 'GET',
    url: '/v1/wallet',
    headers: { authorization: `Bearer ${sipho}` },
  })
).json().accountId;

async function measure(name: string, n: number, fn: () => Promise<{ statusCode: number }>) {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const res = await fn();
    times.push(performance.now() - start);
    if (res.statusCode >= 500) throw new Error(`${name} returned ${res.statusCode}`);
  }
  times.sort((a, b) => a - b);
  const p = (q: number) =>
    times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(1);
  console.log(`${name.padEnd(28)} n=${n}  p50=${p(0.5)}ms  p95=${p(0.95)}ms  max=${p(1)}ms`);
  return Number(p(0.95));
}

const p95Transfer = await measure('POST /v1/transfers', 200, () =>
  app.inject({
    method: 'POST',
    url: '/v1/transfers',
    headers: { authorization: `Bearer ${thandi}`, 'idempotency-key': randomUUID() },
    payload: { toAccountId: siphoAccount, amountCents: 100, reference: 'Bench' },
  }),
);
let cursor: string | null = null;
const p95History = await measure('GET /v1/transfers (paged)', 200, async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/transfers?limit=20${cursor ? `&cursor=${cursor}` : ''}`,
    headers: { authorization: `Bearer ${sipho}` },
  });
  cursor = res.json().nextCursor;
  return res;
});

await app.close();
await handle.close();
redis.disconnect();
redisSub.disconnect();
const pass = p95Transfer < 200 && p95History < 200;
console.log(pass ? 'PASS: p95 under 200 ms' : 'FAIL: p95 over 200 ms');
process.exit(pass ? 0 : 1);
