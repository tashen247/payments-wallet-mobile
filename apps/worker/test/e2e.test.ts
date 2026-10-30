/**
 * The definition-of-done demo, end to end against the real API, worker, Postgres and Redis:
 * user A tops up, scans B's receive QR code and sends R250; B's WebSocket gets the live update and
 * B gets one push notification. Then a forced worker failure lands in the dead-letter view and a
 * replay delivers exactly one notification with the ledger unchanged.
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcile } from '@wallet/db';
import { buildApp } from '@wallet/api/app';
import { loadConfig } from '@wallet/api/config';
import { buildReceiveLink, parseReceiveLink } from '@wallet/shared';
import { makeWorker, useDb, waitFor } from './helpers';

describe('demo flow: two phones, R250 by QR, live balance, push, DLQ replay', () => {
  const ctx = useDb();
  let app: FastifyInstance;
  let base: string;
  let redisSub: Redis;

  beforeAll(async () => {
    redisSub = new Redis(process.env.REDIS_URL!);
    app = await buildApp({
      config: loadConfig(),
      db: ctx.handle.db,
      redis: ctx.redis,
      redisSub,
      logger: false,
    });
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
    redisSub.disconnect();
  });

  const call = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    idem?: string,
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idem ? { 'idempotency-key': idem } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = res.status === 204 ? null : await res.json();
    return { status: res.status, body: json };
  };

  const register = async (displayName: string, phone: string) => {
    const res = await call('POST', '/v1/auth/register', undefined, {
      email: `${displayName.toLowerCase()}-${randomUUID().slice(0, 6)}@demo.co.za`,
      phone,
      displayName,
      password: 'Demo1234!',
    });
    expect(res.status).toBe(201);
    const token = res.body.accessToken as string;
    const wallet = await call('GET', '/v1/wallet', token);
    return {
      token,
      userId: res.body.user.id as string,
      accountId: wallet.body.accountId as string,
    };
  };

  it('sends R250 by QR and B sees it live, with one push', async () => {
    const { worker, push } = makeWorker(ctx);
    const a = await register('Thandi', '0821000001');
    const b = await register('Sipho', '0821000002');
    expect(
      (
        await call('POST', '/v1/devices', b.token, {
          pushToken: 'ExponentPushToken[phone-b]',
          platform: 'android',
        })
      ).status,
    ).toBe(204);

    // Phone B is open on the home screen.
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/ws?token=${b.token}`);
    const live: { type: string; amountCents?: number }[] = [];
    ws.on('message', (m) => live.push(JSON.parse(m.toString())));
    await waitFor(() => live.some((m) => m.type === 'hello'));

    // Phone A tops up, then scans B's QR code.
    expect(
      (await call('POST', '/v1/topups', a.token, { amountCents: 100_000 }, randomUUID())).status,
    ).toBe(201);
    const scanned = parseReceiveLink(buildReceiveLink({ to: b.accountId }));
    expect(scanned).toEqual({ to: b.accountId });
    const name = await call('GET', `/v1/contacts/${scanned!.to}`, a.token);
    expect(name.body.displayName).toBe('Sipho');

    // A confirms with biometrics (app side) and sends R250. The app retries on a flaky network.
    const idem = randomUUID();
    const sent = await call(
      'POST',
      '/v1/transfers',
      a.token,
      { toAccountId: scanned!.to, amountCents: 25_000, reference: 'Braai' },
      idem,
    );
    const retried = await call(
      'POST',
      '/v1/transfers',
      a.token,
      { toAccountId: scanned!.to, amountCents: 25_000, reference: 'Braai' },
      idem,
    );
    expect(sent.status).toBe(201);
    expect(retried.body.id).toBe(sent.body.id);

    worker.start();
    await waitFor(() => live.some((m) => m.type === 'wallet.changed' && m.amountCents === 25_000));
    await waitFor(() => push.sent.length === 1);
    await worker.stop();

    expect(push.sent[0]).toMatchObject({
      to: ['ExponentPushToken[phone-b]'],
      title: 'You received R250.00',
      body: 'From Thandi · Braai',
    });
    expect((await call('GET', '/v1/wallet', b.token)).body.balanceCents).toBe(25_000);
    expect((await call('GET', '/v1/wallet', a.token)).body.balanceCents).toBe(75_000);
    ws.close();
    expect((await reconcile(ctx.handle.db)).ok).toBe(true);
  });

  it('a forced worker failure is dead-lettered, and replay delivers exactly one notification', async () => {
    const { worker, push, setFailTypes } = makeWorker(ctx, { maxAttempts: 3 });
    const a = await register('Thandi', '0821000011');
    const b = await register('Sipho', '0821000012');
    await call('POST', '/v1/devices', b.token, {
      pushToken: 'ExponentPushToken[phone-b]',
      platform: 'ios',
    });
    const admin = await register('Ops', '0821000099');
    await ctx.handle.db.execute(sql`UPDATE users SET role = 'admin' WHERE id = ${admin.userId}`);
    const adminLogin = await call('POST', '/v1/auth/login', undefined, {
      email: (await call('GET', '/v1/me', admin.token)).body.email,
      password: 'Demo1234!',
    });
    const adminToken = adminLogin.body.accessToken as string;

    await call('POST', '/v1/topups', a.token, { amountCents: 100_000 }, randomUUID());
    setFailTypes(['transfer.completed']); // WORKER_FAIL_EVENT_TYPES=transfer.completed
    await call(
      'POST',
      '/v1/transfers',
      a.token,
      { toAccountId: b.accountId, amountCents: 25_000, reference: 'Braai' },
      randomUUID(),
    );

    for (let i = 0; i < 3; i++) await worker.tick();
    const dead = await call('GET', '/v1/admin/dead-letters', adminToken);
    expect(dead.body).toHaveLength(1);
    expect(dead.body[0]).toMatchObject({ type: 'transfer.completed', attempts: 3 });
    expect(push.sent).toHaveLength(0);
    const ledgerBefore = await reconcile(ctx.handle.db);

    setFailTypes([]); // remove the variable
    expect(
      (await call('POST', `/v1/admin/dead-letters/${dead.body[0].id}/replay`, adminToken)).status,
    ).toBe(202);
    expect(
      (await call('POST', `/v1/admin/dead-letters/${dead.body[0].id}/replay`, adminToken)).status,
    ).toBe(409);
    await worker.tick();
    await worker.tick();

    expect(push.sent).toHaveLength(1);
    expect((await call('GET', '/v1/admin/dead-letters', adminToken)).body).toHaveLength(0);
    const ledgerAfter = await reconcile(ctx.handle.db);
    expect(ledgerAfter).toMatchObject({ ok: true, totalDebits: ledgerBefore.totalDebits });
    expect((await call('GET', '/v1/wallet', b.token)).body.balanceCents).toBe(25_000);
  });
});
