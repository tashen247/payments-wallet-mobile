import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auth, key, registerUser, topUp, useHarness } from './helpers';

describe('admin', () => {
  const h = useHarness();

  it('is role-gated', async () => {
    const holder = await registerUser(h);
    for (const url of ['/v1/admin/transfers', '/v1/admin/dead-letters', '/v1/admin/accounts']) {
      const res = await h.app.inject({ method: 'GET', url, headers: auth(holder.token) });
      expect(res.statusCode).toBe(403);
    }
  });

  it('freezes an account (audited): it can neither send, receive nor top up; unfreeze restores it', async () => {
    const admin = await registerUser(h, 'Ops', 'admin');
    const a = await registerUser(h);
    const b = await registerUser(h);
    await topUp(h.app, a, 10_000);
    await topUp(h.app, b, 10_000);
    const freeze = await h.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${a.accountId}/freeze`,
      headers: auth(admin.token),
    });
    expect(freeze.json()).toEqual({ accountId: a.accountId, frozen: true });

    const send = await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: auth(a.token, key()),
      payload: { toAccountId: b.accountId, amountCents: 100 },
    });
    expect(send.statusCode).toBe(423);
    expect(send.json().code).toBe('ACCOUNT_FROZEN');
    const receive = await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: auth(b.token, key()),
      payload: { toAccountId: a.accountId, amountCents: 100 },
    });
    expect(receive.json().code).toBe('ACCOUNT_FROZEN');
    const topup = await h.app.inject({
      method: 'POST',
      url: '/v1/topups',
      headers: auth(a.token, key()),
      payload: { amountCents: 100 },
    });
    expect(topup.json().code).toBe('ACCOUNT_FROZEN');

    await h.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/${a.accountId}/unfreeze`,
      headers: auth(admin.token),
    });
    const after = await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: auth(a.token, key()),
      payload: { toAccountId: b.accountId, amountCents: 100 },
    });
    expect(after.statusCode).toBe(201);

    const audit = await h.handle.db.execute(
      sql`SELECT action FROM audit_events ORDER BY created_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['account.freeze', 'account.unfreeze']);
  });

  it('lists transfers by status and accounts by name', async () => {
    const admin = await registerUser(h, 'Ops', 'admin');
    const a = await registerUser(h, 'Kagiso');
    const b = await registerUser(h, 'Lindiwe');
    await topUp(h.app, a, 1_000);
    await h.app.inject({
      method: 'POST',
      url: '/v1/transfers',
      headers: auth(a.token, key()),
      payload: { toAccountId: b.accountId, amountCents: 5_000 },
    });
    const failed = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/admin/transfers?status=failed',
        headers: auth(admin.token),
      })
    ).json();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      fromName: 'Kagiso',
      toName: 'Lindiwe',
    });
    const all = (
      await h.app.inject({ method: 'GET', url: '/v1/admin/transfers', headers: auth(admin.token) })
    ).json();
    expect(all.find((t: { type: string }) => t.type === 'topup').fromName).toBe('CARD_FUNDING');
    const accounts = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/admin/accounts?q=lind',
        headers: auth(admin.token),
      })
    ).json();
    expect(accounts.map((x: { displayName: string }) => x.displayName)).toEqual(['Lindiwe']);
  });

  it('lists and replays dead letters once, audited', async () => {
    const admin = await registerUser(h, 'Ops', 'admin');
    const ins = await h.handle.db.execute<{ id: string }>(sql`
      INSERT INTO outbox_events (type, payload, status, attempts, last_error, dead_at)
      VALUES ('transfer.completed', '{"amountCents":1,"targets":[]}'::jsonb, 'dead', 5, 'boom', now()) RETURNING id`);
    const id = ins.rows[0]!.id;
    const list = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/admin/dead-letters',
        headers: auth(admin.token),
      })
    ).json();
    expect(list).toEqual([expect.objectContaining({ id, attempts: 5, lastError: 'boom' })]);

    const replay = await h.app.inject({
      method: 'POST',
      url: `/v1/admin/dead-letters/${id}/replay`,
      headers: auth(admin.token),
    });
    expect(replay.statusCode).toBe(202);
    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/admin/dead-letters/${id}/replay`,
      headers: auth(admin.token),
    });
    expect(again.statusCode).toBe(409);
    const row = await h.handle.db.execute(
      sql`SELECT status, attempts FROM outbox_events WHERE id = ${id}`,
    );
    expect(row.rows[0]).toEqual({ status: 'pending', attempts: 0 });
    const audit = await h.handle.db.execute(sql`SELECT action, target_id FROM audit_events`);
    expect(audit.rows).toEqual([{ action: 'dead_letter.replay', target_id: id }]);
  });

  it('exposes the reconciliation report', async () => {
    const admin = await registerUser(h, 'Ops', 'admin');
    const a = await registerUser(h);
    await topUp(h.app, a, 7_500);
    const report = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/admin/reconciliation',
        headers: auth(admin.token),
      })
    ).json();
    expect(report).toMatchObject({ ok: true, totalDebits: 7_500, totalCredits: 7_500 });
  });

  it('detects a tampered balance projection', async () => {
    const a = await registerUser(h);
    await topUp(h.app, a, 1_000);
    const { reconcile } = await import('@wallet/db');
    await h.handle.db.execute(
      sql`UPDATE accounts SET balance_cents = balance_cents + 1 WHERE id = ${a.accountId}`,
    );
    const report = await reconcile(h.handle.db);
    expect(report.ok).toBe(false);
    expect(report.projectionMismatches).toEqual([
      { accountId: a.accountId, balanceCents: 1_001, ledgerCents: 1_000 },
    ]);
    // Put it back so the after-each reconciliation passes.
    await h.handle.db.execute(
      sql`UPDATE accounts SET balance_cents = balance_cents - 1 WHERE id = ${a.accountId}`,
    );
  });
});
