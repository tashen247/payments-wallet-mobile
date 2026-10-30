import { createDb, ensureDatabase, runMigrations } from '@wallet/db';

export default async function setup() {
  const url =
    process.env.TEST_DATABASE_URL_API ?? 'postgres://wallet:wallet@localhost:5432/wallet_test_api';
  await ensureDatabase(url);
  const handle = createDb(url, { max: 1 });
  await runMigrations(handle.db);
  await handle.close();
}
