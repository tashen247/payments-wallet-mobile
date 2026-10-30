import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auth, balanceOf, key, registerUser, topUp, useHarness } from './helpers';

describe('idempotency', () => {
  const h = useHarness();

  const transfer = (token: string, idem: string | undefined, payload: object) =>
    h.app.inject({ method: 'POST', url: '/v1/transfers', headers: auth(token, idem), payload });

  it('requires an Idempotency-Key on money-moving endpoints', async () => {
    const a = await registerUser(h);
    const res = await transfer(a.token, undefined, { toAccountId: a.accountId, amountCents: 100 });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const topup = await h.app.inject({
      method: 'POST',
      url: '/v1/topups',
      headers: auth(a.token),
      payload: { amountCents: 100 },
    });
    expect(topup.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns the original transfer for a repeated key, never a second debit', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 50_000);
    const idem = key();
    const body = { toAccountId: b.accountId, amountCents: 25_000, reference: 'Lunch' };
    const first = await transfer(a.token, idem, body);
    const second = await transfer(a.token, idem, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    expect(await balanceOf(h.app, a)).toBe(25_000);
  });

  it('rejects the same key with a different body', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 50_000);
    const idem = key();
    await transfer(a.token, idem, { toAccountId: b.accountId, amountCents: 100 });
    const res = await transfer(a.token, idem, { toAccountId: b.accountId, amountCents: 200 });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes keys per user', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 1_000);
    await topUp(h.app, b, 1_000);
    const idem = key();
    expect(
      (await transfer(a.token, idem, { toAccountId: b.accountId, amountCents: 100 })).statusCode,
    ).toBe(201);
    expect(
      (await transfer(b.token, idem, { toAccountId: a.accountId, amountCents: 100 })).statusCode,
    ).toBe(201);
  });

  it('returns the same failure on retry instead of trying again', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    const idem = key();
    const body = { toAccountId: b.accountId, amountCents: 5_000 };
    const first = await transfer(a.token, idem, body);
    expect(first.json().code).toBe('INSUFFICIENT_FUNDS');
    await topUp(h.app, a, 10_000);
    const retry = await transfer(a.token, idem, body);
    expect(retry.statusCode).toBe(422);
    expect(retry.json().code).toBe('INSUFFICIENT_FUNDS');
    expect(retry.json().details.replayed).toBe(true);
    expect(await balanceOf(h.app, a)).toBe(10_000);
  });

  it('produces exactly one posting when the same key is fired 10 times at once', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 100_000);
    const idem = key();
    const body = { toAccountId: b.accountId, amountCents: 10_000 };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(a.token, idem, body)),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'false')).toHaveLength(1);
    expect(await balanceOf(h.app, a)).toBe(90_000);
    const n = await h.handle.db.execute(
      sql`SELECT COUNT(*)::int AS n FROM transactions WHERE type = 'transfer'`,
    );
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  it('makes top-ups idempotent too', async () => {
    const a = await registerUser(h);
    const idem = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.app.inject({
          method: 'POST',
          url: '/v1/topups',
          headers: auth(a.token, idem),
          payload: { amountCents: 1_000 },
        }),
      ),
    );
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await balanceOf(h.app, a)).toBe(1_000);
  });
});
