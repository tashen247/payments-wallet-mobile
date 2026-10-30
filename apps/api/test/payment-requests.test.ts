import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auth, balanceOf, key, registerUser, topUp, useHarness } from './helpers';

describe('payment requests', () => {
  const h = useHarness();

  async function setup() {
    const requester = await registerUser(h, 'Zanele');
    const payer = await registerUser(h, 'Pieter');
    await topUp(h.app, payer, 50_000);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payment-requests',
      headers: auth(requester.token),
      payload: { toAccountId: payer.accountId, amountCents: 12_000, reference: 'Taxi share' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { requester, payer, request: res.json() };
  }

  const pay = (token: string, id: string, idem = key()) =>
    h.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${id}/pay`,
      headers: auth(token, idem),
    });

  it('creates a request that both sides can see, with an event for the payer', async () => {
    const { requester, payer, request } = await setup();
    expect(request).toMatchObject({
      direction: 'outgoing',
      status: 'pending',
      counterparty: { displayName: 'Pieter' },
    });
    const incoming = (
      await h.app.inject({ method: 'GET', url: '/v1/payment-requests', headers: auth(payer.token) })
    ).json();
    expect(incoming[0]).toMatchObject({
      id: request.id,
      direction: 'incoming',
      counterparty: { displayName: 'Zanele', accountId: requester.accountId },
    });
    const events = await h.handle.db.execute(
      sql`SELECT type FROM outbox_events WHERE type = 'payment_request.created'`,
    );
    expect(events.rows).toHaveLength(1);
  });

  it('pays a request through the ledger', async () => {
    const { requester, payer, request } = await setup();
    const res = await pay(payer.token, request.id);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      type: 'request_payment',
      status: 'completed',
      amountCents: 12_000,
      reference: 'Taxi share',
    });
    expect(await balanceOf(h.app, payer)).toBe(38_000);
    expect(await balanceOf(h.app, requester)).toBe(12_000);
    const list = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/payment-requests',
        headers: auth(requester.token),
      })
    ).json();
    expect(list[0].status).toBe('paid');
  });

  it('cannot be paid twice, even concurrently with different keys', async () => {
    const { payer, request } = await setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => pay(payer.token, request.id)),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.json().code === 'REQUEST_NOT_PENDING')).toHaveLength(4);
    expect(await balanceOf(h.app, payer)).toBe(38_000);
  });

  it('only the payer can pay or decline', async () => {
    const { requester, request } = await setup();
    expect((await pay(requester.token, request.id)).statusCode).toBe(404);
    const decline = await h.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${request.id}/decline`,
      headers: auth(requester.token),
    });
    expect(decline.statusCode).toBe(404);
    const stranger = await registerUser(h);
    expect((await pay(stranger.token, request.id)).statusCode).toBe(404);
  });

  it('a declined request cannot be paid, and declining twice fails', async () => {
    const { payer, request } = await setup();
    const decline = await h.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${request.id}/decline`,
      headers: auth(payer.token),
    });
    expect(decline.json().status).toBe('declined');
    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/payment-requests/${request.id}/decline`,
      headers: auth(payer.token),
    });
    expect(again.statusCode).toBe(409);
    const res = await pay(payer.token, request.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('REQUEST_NOT_PENDING');
    expect(await balanceOf(h.app, payer)).toBe(50_000);
  });

  it('respects funds and the daily limit when paying', async () => {
    const requester = await registerUser(h);
    const payer = await registerUser(h);
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/payment-requests',
      headers: auth(requester.token),
      payload: { toAccountId: payer.accountId, amountCents: 5_000 },
    });
    const res = await pay(payer.token, created.json().id);
    expect(res.json().code).toBe('INSUFFICIENT_FUNDS');
    const list = (
      await h.app.inject({ method: 'GET', url: '/v1/payment-requests', headers: auth(payer.token) })
    ).json();
    expect(list[0].status).toBe('pending');
  });

  it('cannot request from yourself', async () => {
    const a = await registerUser(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payment-requests',
      headers: auth(a.token),
      payload: { toAccountId: a.accountId, amountCents: 100 },
    });
    expect(res.json().code).toBe('SELF_TRANSFER');
  });
});
