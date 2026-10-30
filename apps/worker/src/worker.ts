import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Db } from '@wallet/db';
import { drainDeadLetterQueue, processMessage, type ConsumerDeps } from './consumer';
import type { PushSender } from './push';
import type { Queue } from './queue/types';
import { relayOnce } from './relay';

export interface WorkerDeps {
  db: Db;
  redis: Redis;
  queue: Queue;
  dlq: Queue;
  push: PushSender;
  log: Logger;
  maxAttempts: number;
  backoffBaseSeconds: number;
  relayIntervalMs: number;
  failEventTypes: () => string[];
  /** Long-poll wait for SQS; 0 in tests. */
  receiveWaitSeconds?: number;
}

export function createWorker(deps: WorkerDeps) {
  const consumer: ConsumerDeps = { ...deps };
  let running = false;
  const loops: Promise<void>[] = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function relayLoop() {
    while (running) {
      try {
        const n = await relayOnce(deps.db, deps.queue, deps.log);
        if (n === 0) await sleep(deps.relayIntervalMs);
      } catch (err) {
        deps.log.error({ err }, 'relay tick failed');
        await sleep(1000);
      }
    }
  }

  async function consumeLoop() {
    while (running) {
      try {
        const messages = await deps.queue.receive(10, deps.receiveWaitSeconds ?? 10);
        if (messages.length === 0) await sleep(deps.relayIntervalMs);
        await Promise.all(messages.map((m) => processMessage(consumer, m)));
      } catch (err) {
        deps.log.error({ err }, 'consume tick failed');
        await sleep(1000);
      }
    }
  }

  async function dlqLoop() {
    while (running) {
      try {
        await drainDeadLetterQueue(deps.db, deps.dlq, deps.log);
      } catch (err) {
        deps.log.error({ err }, 'dlq drain failed');
      }
      await sleep(5000);
    }
  }

  return {
    start() {
      running = true;
      loops.push(relayLoop(), consumeLoop(), dlqLoop());
    },
    async stop() {
      running = false;
      await Promise.allSettled(loops);
    },
    /** One relay pass followed by one receive pass; lets tests drive the pipeline step by step. */
    async tick(): Promise<string[]> {
      await relayOnce(deps.db, deps.queue, deps.log);
      const messages = await deps.queue.receive(10, 0);
      return Promise.all(messages.map((m) => processMessage(consumer, m)));
    },
  };
}
