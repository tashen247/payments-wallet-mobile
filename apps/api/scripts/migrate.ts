import { createDb, runMigrations } from '@wallet/db';

const url = process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet';
const handle = createDb(url, { max: 1 });
await runMigrations(handle.db, process.env.MIGRATIONS_DIR);
console.log('migrations applied');
await handle.close();
