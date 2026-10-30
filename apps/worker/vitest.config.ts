import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL_WORKER ??
        'postgres://wallet:wallet@localhost:5432/wallet_test_worker',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      NODE_ENV: 'test',
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'silent',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 70 },
    },
  },
});
