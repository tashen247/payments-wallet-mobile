import { Redis } from 'ioredis';
import { createDb } from '@wallet/db';
import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const handle = createDb(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL);
const redisSub = new Redis(config.REDIS_URL);

const app = await buildApp({
  config,
  db: handle.db,
  redis,
  redisSub,
  logger:
    config.NODE_ENV === 'development'
      ? {
          level: config.LOG_LEVEL,
          transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } },
        }
      : { level: config.LOG_LEVEL },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await handle.close();
  redis.disconnect();
  redisSub.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
