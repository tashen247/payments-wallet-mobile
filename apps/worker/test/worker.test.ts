import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drainDeadLetterQueue, processMessage } from '../src/consumer';
import { MemoryQueue } from '../src/queue/memory';
import type { Queue } from '../src/queue/types';
import { relayOnce } from '../src/relay';
import {
  eventRow,
  FlakyPushSender,
  insertEvent,
  insertUser,
  log,
  makeWorker,
  useDb,
  waitFor,
} from './helpers';

const PUSH_TOKEN = 'ExponentPushToken[recipient-device]';

describe('outbox relay', () => {
  const ctx = useDb();

  it('publishes pending events once and marks them sent', async () => {
    const { queue } = makeWorker(ctx);
    const user = await insertUser(ctx, 'Sipho');
    const id = await insertEvent(ctx, 'topup.completed', {
      amountCents: 100,
      targets: [{ userId: user, push: null }],
    });
    expect(await relayOnce(ctx.handle.db, queue, log)).toBe(1);
    expect(await relayOnce(ctx.handle.db, queue, log)).toBe(0);
    expect(queue.size()).toBe(1);
    expect((await eventRow(ctx, id)).status).toBe('sent');
  });

  it('keeps events in the outbox while the queue is down, then delivers them', async () => {
    const down: Queue = {
      send: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      receive: async () => [],
      delete: async () => {},
      changeVisibility: async () => {},
    };
    const user = await insertUser(ctx, 'Sipho');
    const id = await insertEvent(ctx, 'topup.completed', {
      amountCents: 100,
      targets: [{ userId: user, push: null }],
    });
    expect(await relayOnce(ctx.handle.db, down, log)).toBe(0);
    expect((await eventRow(ctx, id)).status).toBe('pending');
    const up = new MemoryQueue();
    expect(await relayOnce(ctx.handle.db, up, log)).toBe(1);
    expect((await eventRow(ctx, id)).status).toBe('sent');
  });

  it('lets two relays run side by side without publishing a row twice', async () => {
    const queue = new MemoryQueue();
    const user = await insertUser(ctx, 'Sipho');
    for (let i = 0; i < 40; i++)
      await insertEvent(ctx, 'topup.completed', {
        amountCents: i + 1,
        targets: [{ userId: user, push: null }],
      });
    const counts = await Promise.all([
      relayOnce(ctx.handle.db, queue, log, 25),
      relayOnce(ctx.handle.db, queue, log, 25),
    ]);
    const rest = await relayOnce(ctx.handle.db, queue, log, 25);
    expect(counts[0]! + counts[1]! + rest).toBe(40);
    expect(queue.size()).toBe(40);
  });
});

describe('consumer', () => {
  const ctx = useDb();

  it('publishes the live update and sends the push notification', async () => {
    const { worker, push } = makeWorker(ctx);
    const recipient = await insertUser(ctx, 'Sipho', PUSH_TOKEN);
    const sender = await insertUser(ctx, 'Thandi');
    const id = await insertEvent(ctx, 'transfer.completed', {
      transactionId: '11111111-1111-4111-8111-111111111111',
      amountCents: 25_000,
      targets: [
        { userId: recipient, push: { title: 'You received R250.00', body: 'From Thandi' } },
        { userId: sender, push: null },
      ],
    });
    expect(await worker.tick()).toEqual(['processed']);
    await waitFor(() => ctx.published.length === 2);
    expect(ctx.published.map((p) => p.channel).sort()).toEqual(
      [`ws:user:${recipient}`, `ws:user:${sender}`].sort(),
    );
    expect(ctx.published[0]!.message).toMatchObject({
      type: 'wallet.changed',
      eventType: 'transfer.completed',
      amountCents: 25_000,
    });
    expect(push.sent).toEqual([
      expect.objectContaining({
        to: [PUSH_TOKEN],
        title: 'You received R250.00',
        data: expect.objectContaining({ eventId: id }),
      }),
    ]);
    const processed = await ctx.handle.db.execute(
      sql`SELECT handler FROM processed_events WHERE event_id = ${id} ORDER BY handler`,
    );
    expect(processed.rows.map((r) => r.handler)).toEqual(['push', 'ws']);
  });

  it('ignores a duplicate delivery of the same event', async () => {
    const { worker, queue, push } = makeWorker(ctx);
    const recipient = await insertUser(ctx, 'Sipho', PUSH_TOKEN);
    await insertEvent(ctx, 'transfer.completed', {
      amountCents: 100,
      targets: [{ userId: recipient, push: { title: 't', body: 'b' } }],
    });
    await relayOnce(ctx.handle.db, queue, log);
    // At-least-once delivery: the same message arrives twice.
    const [m] = await queue.receive(1, 0);
    await queue.changeVisibility(m!.receiptHandle, 0);
    await queue.send(m!.body);
    const outcomes = await worker.tick();
    expect(outcomes).toEqual(['processed', 'processed']);
    expect(push.sent).toHaveLength(1);
  });

  it('runs duplicate deliveries concurrently without a double push', async () => {
    const { deps, queue, push } = makeWorker(ctx);
    const recipient = await insertUser(ctx, 'Sipho', PUSH_TOKEN);
    await insertEvent(ctx, 'transfer.completed', {
      amountCents: 100,
      targets: [{ userId: recipient, push: { title: 't', body: 'b' } }],
    });
    await relayOnce(ctx.handle.db, queue, log);
    const [m] = await queue.receive(1, 0);
    for (let i = 0; i < 4; i++) await queue.send(m!.body);
    const all = [m!, ...(await queue.receive(10, 0))];
    await Promise.all(all.map((msg) => processMessage(deps, msg)));
    expect(push.sent).toHaveLength(1);
  });

  it('retries with backoff, then dead-letters after the last attempt', async () => {
    const { worker, queue, setFailTypes } = makeWorker(ctx, { maxAttempts: 3 });
    setFailTypes(['transfer.completed']);
    const user = await insertUser(ctx, 'Sipho');
    const id = await insertEvent(ctx, 'transfer.completed', {
      amountCents: 100,
      targets: [{ userId: user, push: null }],
    });
    expect(await worker.tick()).toEqual(['retry']);
    expect(await eventRow(ctx, id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await worker.tick()).toEqual(['retry']);
    expect(await worker.tick()).toEqual(['dead']);
    const row = await eventRow(ctx, id);
    expect(row).toMatchObject({ status: 'dead', attempts: 3 });
    expect(row.last_error).toContain('Injected failure');
    expect(queue.size()).toBe(0);
    expect(ctx.published).toHaveLength(0);
  });

  it('applies exponential backoff between attempts', async () => {
    const { deps, queue } = makeWorker(ctx, { maxAttempts: 5, backoffBaseSeconds: 2 });
    deps.failEventTypes = () => ['topup.completed'];
    const user = await insertUser(ctx, 'Sipho');
    await insertEvent(ctx, 'topup.completed', {
      amountCents: 100,
      targets: [{ userId: user, push: null }],
    });
    await relayOnce(ctx.handle.db, queue, log);
    const [m] = await queue.receive(1, 0);
    expect(await processMessage(deps, m!)).toBe('retry');
    expect(await queue.receive(1, 0)).toEqual([]); // hidden for 2 seconds
  });

  it('replays a dead letter once: no duplicate push, and only the failed side effect re-runs', async () => {
    const flaky = new FlakyPushSender(3); // push fails every attempt until replay
    const { worker } = makeWorker(ctx, { push: flaky, maxAttempts: 3 });
    const recipient = await insertUser(ctx, 'Sipho', PUSH_TOKEN);
    const id = await insertEvent(ctx, 'transfer.completed', {
      amountCents: 25_000,
      targets: [
        { userId: recipient, push: { title: 'You received R250.00', body: 'From Thandi' } },
      ],
    });
    await worker.tick();
    await worker.tick();
    expect(await worker.tick()).toEqual(['dead']);
    // The live update went out on the first attempt and is not repeated by retries.
    expect(ctx.published).toHaveLength(1);
    expect(flaky.sent).toHaveLength(0);

    // Admin replay: the same SQL the API's replay endpoint runs.
    await ctx.handle.db.execute(
      sql`UPDATE outbox_events SET status = 'pending', attempts = 0, dead_at = NULL WHERE id = ${id}`,
    );
    expect(await worker.tick()).toEqual(['processed']);
    expect(flaky.sent).toHaveLength(1);
    expect(ctx.published).toHaveLength(1);

    // Replaying again does nothing new.
    await ctx.handle.db.execute(sql`UPDATE outbox_events SET status = 'pending' WHERE id = ${id}`);
    expect(await worker.tick()).toEqual(['processed']);
    expect(flaky.sent).toHaveLength(1);
    expect(await eventRow(ctx, id)).toMatchObject({ status: 'sent', last_error: null });
  });

  it('removes push tokens Expo reports as unregistered', async () => {
    const user = await insertUser(ctx, 'Sipho', PUSH_TOKEN);
    const { worker } = makeWorker(ctx, {
      push: { send: async (m) => ({ invalidTokens: m.to }) },
    });
    await insertEvent(ctx, 'payment_request.created', {
      amountCents: 100,
      targets: [{ userId: user, push: { title: 't', body: 'b' } }],
    });
    await worker.tick();
    const rows = await ctx.handle.db.execute(sql`SELECT COUNT(*)::int AS n FROM device_tokens`);
    expect(rows.rows[0]).toEqual({ n: 0 });
  });

  it('records SQS dead-letter-queue messages as dead in the outbox', async () => {
    const dlq = new MemoryQueue();
    const user = await insertUser(ctx, 'Sipho');
    const id = await insertEvent(ctx, 'topup.completed', {
      amountCents: 100,
      targets: [{ userId: user, push: null }],
    });
    await dlq.send(JSON.stringify({ eventId: id }));
    await dlq.send('not json');
    expect(await drainDeadLetterQueue(ctx.handle.db, dlq, log)).toBe(2);
    expect(await eventRow(ctx, id)).toMatchObject({
      status: 'dead',
      last_error: 'Redriven by SQS to the DLQ',
    });
    expect(dlq.size()).toBe(0);
  });

  it('leaves unparseable messages for the SQS redrive', async () => {
    const { deps } = makeWorker(ctx);
    expect(
      await processMessage(deps, {
        messageId: 'm',
        receiptHandle: 'r',
        body: '{"nope":1}',
        receiveCount: 1,
      }),
    ).toBe('invalid');
  });

  it('runs continuously with start and stop', async () => {
    const { worker, push } = makeWorker(ctx);
    const user = await insertUser(ctx, 'Sipho', PUSH_TOKEN);
    worker.start();
    await insertEvent(ctx, 'payment_request.created', {
      amountCents: 100,
      targets: [{ userId: user, push: { title: 't', body: 'b' } }],
    });
    await waitFor(() => push.sent.length === 1);
    await worker.stop();
  });
});

describe('memory queue', () => {
  it('redrives to its dead-letter queue after maxReceiveCount', async () => {
    const dlq = new MemoryQueue();
    const q = new MemoryQueue({ visibilitySeconds: 0, maxReceiveCount: 2, deadLetter: dlq });
    await q.send('x');
    expect((await q.receive(1, 0))[0]!.receiveCount).toBe(1);
    expect((await q.receive(1, 0))[0]!.receiveCount).toBe(2);
    expect(await q.receive(1, 0)).toEqual([]);
    expect(dlq.size()).toBe(1);
  });
});
