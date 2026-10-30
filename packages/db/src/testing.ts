import pg from 'pg';
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { ensureSystemAccounts } from './system-accounts';

/** Creates the database if it does not exist (tests use one database per package). */
export async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}

/** Empties every table and recreates the system accounts. TRUNCATE bypasses the append-only trigger. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.execute(sql`TRUNCATE ledger_entries, transactions, payment_requests, outbox_events, processed_events,
    audit_events, refresh_tokens, device_tokens, accounts, users RESTART IDENTITY CASCADE`);
  await ensureSystemAccounts(db);
}
