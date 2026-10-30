import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CARD_FUNDING } from '@wallet/db';
import { auth, balanceOf, key, registerUser, topUp, useHarness } from './helpers';

describe('top-ups and transfers', () => {
  const h = useHarness();

  const send = (
    token: string,
    toAccountId: string,
    amountCents: number,
    reference = '',
    idem = key(),
  ) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: auth(token, idem),
      payload: { toAccountId, amountCents, reference },
    });

  it('posts a top-up against the card-funding system account', async () => {
    const user = await registerUser(h, 'Naledi');
    const tx = await topUp(h.app, user, 100_000);
    expect(tx).toMatchObject({
      type: 'topup',
      status: 'completed',
      direction: 'topup',
      amountCents: 100_000,
    });
    expect(await balanceOf(h.app, user)).toBe(100_000);

    const funding = await h.handle.db.execute<{ balance_cents: string }>(
      sql`SELECT balance_cents FROM accounts WHERE code = ${CARD_FUNDING}`,
    );
    expect(Number(funding.rows[0]!.balance_cents)).toBe(-100_000);
    const entries = await h.handle.db.execute(
      sql`SELECT direction, amount_cents FROM ledger_entries WHERE transaction_id = ${tx.id} ORDER BY direction`,
    );
    expect(entries.rows).toEqual([
      { direction: 'debit', amount_cents: '100000' },
      { direction: 'credit', amount_cents: '100000' },
    ]);
  });

  it('sends money with balanced entries and an outbox event in the same transaction', async () => {
    const a = await registerUser(h, 'Thandi');
    const b = await registerUser(h, 'Sipho');
    await topUp(h.app, a, 100_000);
    const res = await send(a.token, b.accountId, 25_000, 'Braai money');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'completed',
      direction: 'sent',
      amountCents: 25_000,
      counterparty: { displayName: 'Sipho' },
    });
    expect(await balanceOf(h.app, a)).toBe(75_000);
    expect(await balanceOf(h.app, b)).toBe(25_000);

    const events = await h.handle.db.execute<{
      type: string;
      payload: { targets: { userId: string; push: unknown }[] };
    }>(sql`SELECT type, payload FROM outbox_events WHERE type = 'transfer.completed'`);
    expect(events.rows).toHaveLength(1);
    const targets = events.rows[0]!.payload.targets;
    expect(targets.find((t) => t.userId === b.userId)?.push).toMatchObject({
      title: 'You received R250.00',
    });
    expect(targets.find((t) => t.userId === a.userId)?.push).toBeNull();
  });

  it('rejects insufficient funds, records the failure and writes no ledger entries or events', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 10_000);
    const res = await send(a.token, b.accountId, 10_001);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('INSUFFICIENT_FUNDS');
    expect(res.json().details.transaction.status).toBe('failed');
    const counts = await h.handle.db.execute<{ entries: string; events: string }>(sql`
      SELECT (SELECT COUNT(*) FROM ledger_entries l JOIN transactions t ON t.id = l.transaction_id WHERE t.type = 'transfer') AS entries,
             (SELECT COUNT(*) FROM outbox_events WHERE type = 'transfer.completed') AS events`);
    expect(counts.rows[0]).toEqual({ entries: '0', events: '0' });
    expect(await balanceOf(h.app, a)).toBe(10_000);
  });

  it('rejects self-transfers and unknown recipients', async () => {
    const a = await registerUser(h);
    await topUp(h.app, a, 10_000);
    const self = await send(a.token, a.accountId, 100);
    expect(self.json().code).toBe('SELF_TRANSFER');
    const unknown = await send(a.token, '00000000-0000-4000-8000-000000000000', 100);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('RECIPIENT_NOT_FOUND');
  });

  it('cannot send money to a system account', async () => {
    const a = await registerUser(h);
    await topUp(h.app, a, 10_000);
    const funding = await h.handle.db.execute<{ id: string }>(
      sql`SELECT id FROM accounts WHERE code = ${CARD_FUNDING}`,
    );
    const res = await send(a.token, funding.rows[0]!.id, 100);
    expect(res.json().code).toBe('RECIPIENT_NOT_FOUND');
  });

  it('enforces the R5 000 daily limit across transfers', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 1_000_000);
    expect((await send(a.token, b.accountId, 300_000)).statusCode).toBe(201);
    expect((await send(a.token, b.accountId, 200_000)).statusCode).toBe(201);
    const over = await send(a.token, b.accountId, 1);
    expect(over.statusCode).toBe(422);
    expect(over.json().code).toBe('DAILY_LIMIT_EXCEEDED');
    const wallet = await h.app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(a.token) });
    expect(wallet.json().sentTodayCents).toBe(500_000);
  });

  it('only counts today in South African time towards the limit', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 1_000_000);
    expect((await send(a.token, b.accountId, 500_000)).statusCode).toBe(201);
    // Move that transfer to just before midnight SAST yesterday.
    await h.handle.db.execute(sql`UPDATE transactions SET created_at =
      (date_trunc('day', now() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg') - interval '1 second'
      WHERE type = 'transfer'`);
    expect((await send(a.token, b.accountId, 500_000)).statusCode).toBe(201);
  });

  it('lists history with filters, reference search and keyset pagination', async () => {
    const a = await registerUser(h, 'Thandi');
    const b = await registerUser(h, 'Sipho');
    await topUp(h.app, a, 100_000);
    for (let i = 1; i <= 5; i++) await send(a.token, b.accountId, 1_000 * i, `Rent ${i}`);
    await topUp(h.app, b, 5_000);
    await send(b.token, a.accountId, 500, 'Coffee');

    const all = await h.app.inject({
      method: 'GET',
      url: '/v1/transfers?limit=3',
      headers: auth(a.token),
    });
    const page1 = all.json();
    expect(page1.items).toHaveLength(3);
    expect(page1.items[0]).toMatchObject({
      direction: 'received',
      reference: 'Coffee',
      counterparty: { displayName: 'Sipho' },
    });
    const page2 = (
      await h.app.inject({
        method: 'GET',
        url: `/v1/transfers?limit=3&cursor=${page1.nextCursor}`,
        headers: auth(a.token),
      })
    ).json();
    expect(page2.items).toHaveLength(3);
    const page3 = (
      await h.app.inject({
        method: 'GET',
        url: `/v1/transfers?limit=3&cursor=${page2.nextCursor}`,
        headers: auth(a.token),
      })
    ).json();
    expect(page3.items).toHaveLength(1); // 1 top-up + 5 sent + 1 received = 7
    expect(page3.items[0].direction).toBe('topup');
    expect(page3.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items, ...page3.items].map((t: { id: string }) => t.id);
    expect(new Set(ids).size).toBe(7);

    const sent = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/transfers?filter=sent',
        headers: auth(a.token),
      })
    ).json();
    expect(sent.items).toHaveLength(5);
    const received = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/transfers?filter=received',
        headers: auth(a.token),
      })
    ).json();
    expect(received.items).toHaveLength(1);
    const topups = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/transfers?filter=topup',
        headers: auth(a.token),
      })
    ).json();
    expect(topups.items).toHaveLength(1);
    const search = (
      await h.app.inject({ method: 'GET', url: '/v1/transfers?q=rent%203', headers: auth(a.token) })
    ).json();
    expect(search.items.map((t: { reference: string }) => t.reference)).toEqual(['Rent 3']);
  });

  it('hides failed incoming transfers from the recipient and other users’ transactions from everyone', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    const c = await registerUser(h);
    const failed = await send(a.token, b.accountId, 100); // no funds
    const txId = failed.json().details.transaction.id;
    expect(
      (await h.app.inject({ method: 'GET', url: `/v1/transfers/${txId}`, headers: auth(a.token) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await h.app.inject({ method: 'GET', url: `/v1/transfers/${txId}`, headers: auth(b.token) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await h.app.inject({ method: 'GET', url: `/v1/transfers/${txId}`, headers: auth(c.token) }))
        .statusCode,
    ).toBe(404);
  });

  it('finds contacts by name, email or phone, excluding yourself', async () => {
    const a = await registerUser(h, 'Thandi Nkosi');
    await registerUser(h, 'Sipho Dlamini');
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/contacts/search?q=dlam',
      headers: auth(a.token),
    });
    expect(res.json().map((c: { displayName: string }) => c.displayName)).toEqual([
      'Sipho Dlamini',
    ]);
    const self = await h.app.inject({
      method: 'GET',
      url: '/v1/contacts/search?q=thandi',
      headers: auth(a.token),
    });
    expect(self.json()).toEqual([]);
  });

  it('resolves a QR recipient account to a display name', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h, 'Ayanda');
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/contacts/${b.accountId}`,
      headers: auth(a.token),
    });
    expect(res.json()).toEqual({ accountId: b.accountId, displayName: 'Ayanda' });
  });

  it('keeps the ledger append-only at the database level', async () => {
    const a = await registerUser(h);
    await topUp(h.app, a, 1_000);
    await expect(
      h.handle.db.execute(sql`UPDATE ledger_entries SET amount_cents = 1`),
    ).rejects.toThrow();
    await expect(h.handle.db.execute(sql`DELETE FROM ledger_entries`)).rejects.toThrow();
  });

  it('registers push tokens', async () => {
    const a = await registerUser(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: auth(a.token),
      payload: { pushToken: 'ExponentPushToken[abc123def]', platform: 'ios' },
    });
    expect(res.statusCode).toBe(204);
    const again = await h.app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: auth(a.token),
      payload: { pushToken: 'ExponentPushToken[abc123def]', platform: 'ios' },
    });
    expect(again.statusCode).toBe(204);
    const rows = await h.handle.db.execute(sql`SELECT COUNT(*)::int AS n FROM device_tokens`);
    expect(rows.rows[0]).toEqual({ n: 1 });
  });
});
