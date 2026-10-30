import { createDb, databaseUrlFromEnv, runMigrations } from '../src';

const url = databaseUrlFromEnv();
const handle = createDb(url, { max: 1 });
await runMigrations(handle.db);
console.log('migrations applied');
await handle.close();
