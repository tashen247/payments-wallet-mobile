import { describe, expect, it } from 'vitest';
import { auth, balanceOf, key, registerUser, topUp, useHarness } from './helpers';

describe('concurrency', () => {
  const h = useHarness();

  const send = (token: string, toAccountId: string, amountCents: number) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: auth(token, key()),
      payload: { toAccountId, amountCents },
    });

  it('50 concurrent transfers from one account never overdraw it', async () => {
    const a = await registerUser(h, 'Sender');
    const b = await registerUser(h, 'Receiver');
    await topUp(h.app, a, 30_000); // R300: only 30 of the 50 R10 sends can succeed
    const results = await Promise.all(
      Array.from({ length: 50 }, () => send(a.token, b.accountId, 1_000)),
    );
    const ok = results.filter((r) => r.statusCode === 201).length;
    const declined = results.filter((r) => r.json().code === 'INSUFFICIENT_FUNDS').length;
    expect(ok).toBe(30);
    expect(declined).toBe(20);
    expect(ok + declined).toBe(50);
    expect(await balanceOf(h.app, a)).toBe(0);
    expect(await balanceOf(h.app, b)).toBe(30_000);
  });

  it('opposite transfers at the same time do not deadlock', async () => {
    const a = await registerUser(h, 'Amahle');
    const b = await registerUser(h, 'Bongani');
    await topUp(h.app, a, 100_000);
    await topUp(h.app, b, 100_000);
    const jobs: Promise<{ statusCode: number; body: string }>[] = [];
    for (let i = 0; i < 25; i++) {
      jobs.push(send(a.token, b.accountId, 1_000));
      jobs.push(send(b.token, a.accountId, 700));
    }
    const results = await Promise.all(jobs);
    for (const r of results) expect(r.statusCode, r.body).toBe(201);
    expect(await balanceOf(h.app, a)).toBe(100_000 - 25 * 1_000 + 25 * 700);
    expect(await balanceOf(h.app, b)).toBe(100_000 + 25 * 1_000 - 25 * 700);
  });

  it('concurrent sends cannot exceed the daily limit together', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 2_000_000);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => send(a.token, b.accountId, 40_000)),
    ); // 20 x R400
    const ok = results.filter((r) => r.statusCode === 201).length;
    expect(ok).toBe(12); // 12 x R400 = R4 800; a 13th would be R5 200
    expect(results.filter((r) => r.json().code === 'DAILY_LIMIT_EXCEEDED')).toHaveLength(8);
    const wallet = await h.app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(a.token) });
    expect(wallet.json().sentTodayCents).toBeLessThanOrEqual(500_000);
  });

  it('a freeze waits for in-flight transfers and blocks the ones after it', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    const admin = await registerUser(h, 'Ops', 'admin');
    await topUp(h.app, a, 100_000);
    const sends = Array.from({ length: 10 }, () => send(a.token, b.accountId, 1_000));
    const freeze = h.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${a.accountId}/freeze`,
      headers: auth(admin.token),
    });
    const results = await Promise.all([...sends, freeze]);
    const transfers = results.slice(0, 10);
    for (const r of transfers) expect([201, 423]).toContain(r.statusCode);
    const ok = transfers.filter((r) => r.statusCode === 201).length;
    expect(await balanceOf(h.app, a)).toBe(100_000 - ok * 1_000);
    expect((await send(a.token, b.accountId, 1_000)).statusCode).toBe(423);
  });
});
