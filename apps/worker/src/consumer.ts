import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Db } from '@wallet/db';
import { QueueMessage, wsChannelForUser, type WsServerMessage } from '@wallet/shared';
import type { PushSender } from './push';
import type { Queue, ReceivedMessage } from './queue/types';

export interface ConsumerDeps {
  db: Db;
  redis: Redis;
  queue: Queue;
  push: PushSender;
  log: Logger;
  maxAttempts: number;
  backoffBaseSeconds: number;
  /** Fault injection: event types that fail on purpose. */
  failEventTypes: () => string[];
}

export type Outcome = 'processed' | 'retry' | 'dead' | 'invalid';

/**
 * Runs one side effect at most once per event. The processed_events row is inserted first, inside
 * a transaction that stays open while the side effect runs: a concurrent duplicate blocks on the
 * primary key until this commits, then skips. If the side effect throws, the transaction rolls
 * back and the row disappears, so the retry runs it again.
 */
async function once(
  db: Db,
  eventId: string,
  handler: string,
  effect: () => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      INSERT INTO processed_events (event_id, handler) VALUES (${eventId}, ${handler})
      ON CONFLICT DO NOTHING RETURNING event_id`);
    if (res.rows.length === 0) return false;
    await effect();
    return true;
  });
}

export async function handleEvent(deps: ConsumerDeps, msg: QueueMessage): Promise<void> {
  if (deps.failEventTypes().includes(msg.type)) {
    throw new Error(`Injected failure for ${msg.type} (WORKER_FAIL_EVENT_TYPES)`);
  }
  const log = deps.log.child({
    eventId: msg.eventId,
    correlationId: msg.correlationId,
    type: msg.type,
  });

  await once(deps.db, msg.eventId, 'ws', async () => {
    const wsMessage: WsServerMessage = {
      type: 'wallet.changed',
      eventType: msg.type,
      transactionId: msg.payload.transactionId ?? null,
      paymentRequestId: msg.payload.paymentRequestId ?? null,
      amountCents: msg.payload.amountCents,
    };
    for (const target of msg.payload.targets) {
      await deps.redis.publish(wsChannelForUser(target.userId), JSON.stringify(wsMessage));
    }
  });

  const pushTargets = msg.payload.targets.filter((t) => t.push);
  if (pushTargets.length === 0) return;
  const sent = await once(deps.db, msg.eventId, 'push', async () => {
    for (const target of pushTargets) {
      const tokens = await deps.db.execute<{ token: string }>(
        sql`SELECT token FROM device_tokens WHERE user_id = ${target.userId}`,
      );
      if (tokens.rows.length === 0) continue;
      const result = await deps.push.send({
        to: tokens.rows.map((r) => r.token),
        title: target.push!.title,
        body: target.push!.body,
        data: {
          eventId: msg.eventId,
          type: msg.type,
          transactionId: msg.payload.transactionId,
          paymentRequestId: msg.payload.paymentRequestId,
        },
      });
      for (const token of result.invalidTokens) {
        await deps.db.execute(sql`DELETE FROM device_tokens WHERE token = ${token}`);
      }
    }
  });
  if (!sent) log.info('push already sent for this event; skipped');
}

export async function processMessage(
  deps: ConsumerDeps,
  received: ReceivedMessage,
): Promise<Outcome> {
  let parsed: QueueMessage;
  try {
    parsed = QueueMessage.parse(JSON.parse(received.body));
  } catch (err) {
    deps.log.error(
      { err, messageId: received.messageId },
      'unparseable message; leaving for SQS redrive',
    );
    return 'invalid';
  }
  const log = deps.log.child({
    eventId: parsed.eventId,
    correlationId: parsed.correlationId,
    type: parsed.type,
  });
  try {
    await handleEvent(deps, parsed);
    await deps.db.execute(
      sql`UPDATE outbox_events SET attempts = ${received.receiveCount}, last_error = NULL WHERE id = ${parsed.eventId}`,
    );
    await deps.queue.delete(received.receiptHandle);
    log.info({ attempt: received.receiveCount }, 'event processed');
    return 'processed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (received.receiveCount >= deps.maxAttempts) {
      // Dead letters live in one place: the outbox table, which the admin screen reads.
      await deps.db.execute(sql`
        UPDATE outbox_events SET status = 'dead', dead_at = now(), attempts = ${received.receiveCount}, last_error = ${message}
        WHERE id = ${parsed.eventId}`);
      await deps.queue.delete(received.receiptHandle);
      log.error({ attempt: received.receiveCount, error: message }, 'event dead-lettered');
      return 'dead';
    }
    await deps.db.execute(
      sql`UPDATE outbox_events SET attempts = ${received.receiveCount}, last_error = ${message} WHERE id = ${parsed.eventId}`,
    );
    const backoff = deps.backoffBaseSeconds * 2 ** (received.receiveCount - 1);
    await deps.queue.changeVisibility(received.receiptHandle, Math.min(backoff, 300));
    log.warn(
      { attempt: received.receiveCount, retryInSeconds: backoff, error: message },
      'event failed; will retry',
    );
    return 'retry';
  }
}

/**
 * Safety net for the SQS dead-letter queue (messages the consumer could not even parse, or that
 * exceeded SQS's own receive count). They are recorded as dead in the outbox so the admin screen
 * remains the single place to see and replay them.
 */
export async function drainDeadLetterQueue(db: Db, dlq: Queue, log: Logger): Promise<number> {
  const messages = await dlq.receive(10, 0);
  for (const m of messages) {
    let eventId: string | undefined;
    try {
      eventId = (JSON.parse(m.body) as { eventId?: string }).eventId;
    } catch {
      /* fall through */
    }
    if (eventId) {
      await db.execute(sql`
        UPDATE outbox_events SET status = 'dead', dead_at = now(), last_error = COALESCE(last_error, 'Redriven by SQS to the DLQ')
        WHERE id = ${eventId} AND status <> 'dead'`);
    } else {
      log.error({ body: m.body.slice(0, 500) }, 'unidentifiable DLQ message discarded');
    }
    await dlq.delete(m.receiptHandle);
  }
  return messages.length;
}
