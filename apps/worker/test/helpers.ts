import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import pino from 'pino';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createDb, resetDatabase, type DbHandle } from '@wallet/db';
import type { OutboxPayload, OutboxEventType } from '@wallet/shared';
import {
  RecordingPushSender,
  type PushMessage,
  type PushResult,
  type PushSender,
} from '../src/push';
import { MemoryQueue } from '../src/queue/memory';
import { createWorker, type WorkerDeps } from '../src/worker';

export const log = pino({ level: 'silent' });

export interface Ctx {
  handle: DbHandle;
  redis: Redis;
  sub: Redis;
  published: { channel: string; message: unknown }[];
}

export function useDb(): Ctx {
  const ctx = { published: [] } as unknown as Ctx;
  beforeAll(async () => {
    ctx.handle = createDb(process.env.DATABASE_URL!, { max: 20 });
    ctx.redis = new Redis(process.env.REDIS_URL!);
    ctx.sub = new Redis(process.env.REDIS_URL!);
    ctx.sub.on('pmessage', (_p, channel, message) =>
      ctx.published.push({ channel, message: JSON.parse(message) }),
    );
    await ctx.sub.psubscribe('ws:user:*');
  });
  beforeEach(async () => {
    await resetDatabase(ctx.handle.db);
    ctx.published.length = 0;
  });
  afterAll(async () => {
    await ctx.handle.close();
    ctx.redis.disconnect();
    ctx.sub.disconnect();
  });
  return ctx;
}

export async function insertUser(ctx: Ctx, name: string, pushToken?: string): Promise<string> {
  const id = randomUUID();
  await ctx.handle.db.execute(sql`
    INSERT INTO users (id, email, phone, display_name, password_hash)
    VALUES (${id}, ${`${id}@example.co.za`}, ${`+27${id.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`}, ${name}, 'x')`);
  if (pushToken)
    await ctx.handle.db.execute(
      sql`INSERT INTO device_tokens (user_id, token, platform) VALUES (${id}, ${pushToken}, 'ios')`,
    );
  return id;
}

export async function insertEvent(
  ctx: Ctx,
  type: OutboxEventType,
  payload: OutboxPayload,
): Promise<string> {
  const res = await ctx.handle.db.execute<{ id: string }>(sql`
    INSERT INTO outbox_events (type, payload, correlation_id) VALUES (${type}, ${JSON.stringify(payload)}::jsonb, 'test-corr') RETURNING id`);
  return res.rows[0]!.id;
}

export async function eventRow(ctx: Ctx, id: string) {
  const res = await ctx.handle.db.execute<{
    status: string;
    attempts: number;
    last_error: string | null;
  }>(sql`SELECT status, attempts, last_error FROM outbox_events WHERE id = ${id}`);
  return res.rows[0]!;
}

/** Fails the first `failures` sends, then records. */
export class FlakyPushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  calls = 0;
  constructor(private failures: number) {}
  async send(message: PushMessage): Promise<PushResult> {
    this.calls++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error('Expo push service unavailable');
    }
    this.sent.push(message);
    return { invalidTokens: [] };
  }
}

export function makeWorker(ctx: Ctx, overrides: Partial<WorkerDeps> = {}) {
  const dlq = new MemoryQueue();
  const queue = new MemoryQueue({ visibilitySeconds: 30, maxReceiveCount: 10, deadLetter: dlq });
  const push = new RecordingPushSender();
  let failTypes: string[] = [];
  const deps: WorkerDeps = {
    db: ctx.handle.db,
    redis: ctx.redis,
    queue,
    dlq,
    push,
    log,
    maxAttempts: 3,
    backoffBaseSeconds: 0,
    relayIntervalMs: 10,
    receiveWaitSeconds: 0,
    failEventTypes: () => failTypes,
    ...overrides,
  };
  const worker = createWorker(deps);
  return {
    worker,
    deps,
    queue: deps.queue as MemoryQueue,
    dlq: deps.dlq as MemoryQueue,
    push: deps.push as RecordingPushSender,
    setFailTypes: (t: string[]) => (failTypes = t),
  };
}

export const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};
