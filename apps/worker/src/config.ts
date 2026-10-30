import { z } from 'zod';

const list = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://wallet:wallet@localhost:5432/wallet'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  LOG_LEVEL: z.string().default('info'),
  /** sqs: SQS or LocalStack. memory: in-process queue, for running without LocalStack. */
  QUEUE_DRIVER: z.enum(['sqs', 'memory']).default('sqs'),
  AWS_REGION: z.string().default('af-south-1'),
  SQS_ENDPOINT: z.string().optional(),
  SQS_QUEUE_NAME: z.string().default('wallet-events'),
  SQS_DLQ_NAME: z.string().default('wallet-events-dlq'),
  SQS_QUEUE_URL: z.string().optional(),
  SQS_DLQ_URL: z.string().optional(),
  /** Create the queues on start-up (LocalStack only). */
  SQS_AUTO_CREATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PUSH_DRIVER: z.enum(['expo', 'log']).default('expo'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  BACKOFF_BASE_SECONDS: z.coerce.number().min(0).default(2),
  RELAY_INTERVAL_MS: z.coerce.number().int().default(250),
  /** Fault injection: fail these event types on purpose, e.g. transfer.completed. */
  WORKER_FAIL_EVENT_TYPES: list,
});

export type WorkerConfig = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): WorkerConfig => Env.parse(env);
