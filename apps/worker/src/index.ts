import { Redis } from 'ioredis';
import pino from 'pino';
import { createDb } from '@wallet/db';
import { loadConfig } from './config';
import { ExpoPushSender, RecordingPushSender } from './push';
import { MemoryQueue } from './queue/memory';
import { createSqsQueues } from './queue/sqs';
import type { Queue } from './queue/types';
import { createWorker } from './worker';

const config = loadConfig();
const log = pino({
  level: config.LOG_LEVEL,
  base: { service: 'worker' },
  ...(config.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
    : {}),
});

const handle = createDb(config.DATABASE_URL, { max: 10 });
const redis = new Redis(config.REDIS_URL);

let queue: Queue;
let dlq: Queue;
if (config.QUEUE_DRIVER === 'memory') {
  const memoryDlq = new MemoryQueue();
  queue = new MemoryQueue({
    visibilitySeconds: 30,
    maxReceiveCount: config.MAX_ATTEMPTS + 1,
    deadLetter: memoryDlq,
  });
  dlq = memoryDlq;
} else {
  ({ main: queue, dlq } = await createSqsQueues(config));
}

if (config.WORKER_FAIL_EVENT_TYPES.length) {
  log.warn(
    { types: config.WORKER_FAIL_EVENT_TYPES },
    'fault injection enabled: these events will fail',
  );
}

const worker = createWorker({
  db: handle.db,
  redis,
  queue,
  dlq,
  push:
    config.PUSH_DRIVER === 'log'
      ? new RecordingPushSender(log)
      : new ExpoPushSender(config.EXPO_ACCESS_TOKEN, log),
  log,
  maxAttempts: config.MAX_ATTEMPTS,
  backoffBaseSeconds: config.BACKOFF_BASE_SECONDS,
  relayIntervalMs: config.RELAY_INTERVAL_MS,
  failEventTypes: () => config.WORKER_FAIL_EVENT_TYPES,
});

worker.start();
log.info({ queue: config.QUEUE_DRIVER }, 'worker started');

const shutdown = async () => {
  log.info('worker stopping');
  await worker.stop();
  await handle.close();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
