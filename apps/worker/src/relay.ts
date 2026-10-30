import { sql } from 'drizzle-orm';
import type { Db } from '@wallet/db';
import type { QueueMessage } from '@wallet/shared';
import type { Logger } from 'pino';
import type { Queue } from './queue/types';

/**
 * Moves pending outbox rows onto the queue. Rows are claimed with FOR UPDATE SKIP LOCKED so several
 * worker instances can relay in parallel without publishing the same row twice at once. If the
 * queue is unreachable the rows stay pending and are retried on the next tick: nothing is lost.
 * Delivery is at-least-once (a crash after publish but before commit republishes), which the
 * consumer's de-duplication absorbs.
 */
export async function relayOnce(
  db: Db,
  queue: Queue,
  log: Logger,
  batchSize = 50,
): Promise<number> {
  return db.transaction(async (tx) => {
    const res = await tx.execute<{
      id: string;
      type: QueueMessage['type'];
      payload: QueueMessage['payload'];
      correlation_id: string | null;
    }>(sql`
      SELECT id, type, payload, correlation_id FROM outbox_events
      WHERE status = 'pending' ORDER BY created_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`);
    const published: string[] = [];
    for (const row of res.rows) {
      const message: QueueMessage = {
        eventId: row.id,
        type: row.type,
        correlationId: row.correlation_id,
        payload: row.payload,
      };
      try {
        await queue.send(JSON.stringify(message));
        published.push(row.id);
      } catch (err) {
        log.warn(
          { err, eventId: row.id, correlationId: row.correlation_id },
          'queue unavailable; event stays in outbox',
        );
        break;
      }
    }
    if (published.length) {
      await tx.execute(sql`
        UPDATE outbox_events SET status = 'sent', sent_at = now()
        WHERE id IN (${sql.join(
          published.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
    }
    return published.length;
  });
}
