import { createDb, databaseUrlFromEnv, runMigrations } from '@wallet/db';

const url = databaseUrlFromEnv();
const handle = createDb(url, { max: 1 });
await runMigrations(handle.db, process.env.MIGRATIONS_DIR);
console.log('migrations applied');
await handle.close();
