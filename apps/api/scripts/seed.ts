/**
 * Seeds demo users and realistic South African history.
 *
 *   pnpm db:seed                         demo logins + a few hundred transactions
 *   SEED_TRANSACTIONS=10000 pnpm db:seed bulk history for the performance check
 *
 * Demo users are posted through the real posting service. Bulk history is inserted directly with
 * balanced double entries and back-dated timestamps (so it does not trip today's send limit), and
 * the run finishes with a reconciliation check that fails the seed if anything is off.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  CARD_FUNDING,
  createDb,
  databaseUrlFromEnv,
  getSystemAccountId,
  reconcile,
  runMigrations,
  users,
} from '@wallet/db';
import { register } from '../src/services/auth';
import { getUserAccount } from '../src/services/accounts';
import { topUp, transfer } from '../src/services/money';

const DEMO_PASSWORD = 'Demo1234!';
const url = databaseUrlFromEnv();
const bulk = Number(process.env.SEED_TRANSACTIONS ?? 300);

const demo = [
  {
    email: 'thandi@demo.co.za',
    phone: '+27821000001',
    displayName: 'Thandi Nkosi',
    role: 'holder' as const,
  },
  {
    email: 'sipho@demo.co.za',
    phone: '+27821000002',
    displayName: 'Sipho Dlamini',
    role: 'holder' as const,
  },
  {
    email: 'ops@demo.co.za',
    phone: '+27821000099',
    displayName: 'Operations',
    role: 'admin' as const,
  },
];

const others = [
  'Lerato Mokoena',
  'Pieter van der Merwe',
  'Ayanda Khumalo',
  'Zanele Mthembu',
  'Johan Botha',
  'Nomvula Zulu',
  'Kagiso Molefe',
  'Fatima Patel',
  'Rajesh Naidoo',
  'Annelie Steyn',
  'Bongani Ndlovu',
  'Lindiwe Sithole',
  'Tshepo Maseko',
  'Chantelle Jacobs',
  'Musa Cele',
  'Ingrid du Toit',
  'Yusuf Ebrahim',
  'Palesa Radebe',
];

const references = [
  'Rent',
  'Braai',
  'Taxi fare',
  'Stokvel',
  'Groceries',
  'Electricity',
  'Soccer fees',
  'Data bundle',
  'Airtime',
  'Lift club',
  'Birthday gift',
  'School trip',
  'Coffee',
  'Bunny chow',
  'Car wash',
  'Petrol money',
  'Concert tickets',
  'Dinner',
  'Gym',
  'Plumber',
];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const slug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.');

const handle = createDb(url, { max: 10 });
const { db } = handle;
await runMigrations(db, process.env.MIGRATIONS_DIR);

const [existing] = await db.select().from(users).where(eq(users.email, demo[0]!.email));
if (existing) {
  console.log('demo users already exist; skipping seed');
  await handle.close();
  process.exit(0);
}

const ctx = (userId: string, displayName: string) => ({
  userId,
  displayName,
  idempotencyKey: randomUUID(),
  correlationId: 'seed',
});

const created: { id: string; name: string; accountId: string }[] = [];
for (const d of demo) {
  const user = await register(db, { ...d, password: DEMO_PASSWORD });
  created.push({
    id: user.id,
    name: user.displayName,
    accountId: (await getUserAccount(db, user.id)).id,
  });
}
for (const [i, name] of others.entries()) {
  const user = await register(db, {
    email: `${slug(name)}@demo.co.za`,
    phone: `+2782200${String(i).padStart(4, '0')}`,
    displayName: name,
    password: DEMO_PASSWORD,
  });
  created.push({ id: user.id, name, accountId: (await getUserAccount(db, user.id)).id });
}

const [thandi, sipho] = created;
const holders = created.filter((_, i) => i !== 2);

// A believable recent story for the two demo users, through the real posting service.
await topUp(db, ctx(thandi!.id, thandi!.name), 300_000);
await topUp(db, ctx(sipho!.id, sipho!.name), 80_000);
await transfer(db, ctx(thandi!.id, thandi!.name), {
  toAccountId: sipho!.accountId,
  amountCents: 15_000,
  reference: 'Braai',
});
await transfer(db, ctx(sipho!.id, sipho!.name), {
  toAccountId: thandi!.accountId,
  amountCents: 4_500,
  reference: 'Taxi fare',
});

// Bulk history: balanced entries, spread over the last 180 days.
const funding = await getSystemAccountId(db, CARD_FUNDING);
const balances = new Map<string, number>();
for (const h of holders) balances.set(h.accountId, (await getUserAccount(db, h.id)).balanceCents);

const BATCH = 500;
let written = 0;
while (written < bulk) {
  await db.transaction(async (tx) => {
    const txRows: string[] = [];
    const entryRows: string[] = [];
    for (let i = 0; i < Math.min(BATCH, bulk - written); i++) {
      const id = randomUUID();
      const when = new Date(Date.now() - (2 + Math.random() * 178) * 86_400_000).toISOString();
      const from = pick(holders);
      let to = pick(holders);
      while (to.accountId === from.accountId) to = pick(holders);
      const amount = 500 + Math.floor(Math.random() * 60) * 500; // R5 to R300
      const needsTopup = (balances.get(from.accountId) ?? 0) < amount;
      if (needsTopup) {
        const topupId = randomUUID();
        const topupAmount = 200_000;
        txRows.push(
          `('${topupId}','topup','completed','${from.id}','seed-${topupId}','seed','${funding}','${from.accountId}',${topupAmount},'Card top-up','${when}','${when}')`,
        );
        entryRows.push(
          `('${topupId}','${funding}','debit',${topupAmount},'${when}')`,
          `('${topupId}','${from.accountId}','credit',${topupAmount},'${when}')`,
        );
        balances.set(from.accountId, (balances.get(from.accountId) ?? 0) + topupAmount);
      }
      const ref = pick(references).replace(/'/g, "''");
      txRows.push(
        `('${id}','transfer','completed','${from.id}','seed-${id}','seed','${from.accountId}','${to.accountId}',${amount},'${ref}','${when}','${when}')`,
      );
      entryRows.push(
        `('${id}','${from.accountId}','debit',${amount},'${when}')`,
        `('${id}','${to.accountId}','credit',${amount},'${when}')`,
      );
      balances.set(from.accountId, (balances.get(from.accountId) ?? 0) - amount);
      balances.set(to.accountId, (balances.get(to.accountId) ?? 0) + amount);
    }
    await tx.execute(
      sql.raw(`INSERT INTO transactions (id, type, status, user_id, idempotency_key, request_hash,
      from_account_id, to_account_id, amount_cents, reference, created_at, completed_at) VALUES ${txRows.join(',')}`),
    );
    await tx.execute(
      sql.raw(`INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_cents, created_at)
      VALUES ${entryRows.join(',')}`),
    );
    written += txRows.length;
  });
}

// Rebuild the balance projections from the ledger, then prove they match.
await db.execute(sql`
  UPDATE accounts a SET balance_cents = COALESCE((
    SELECT SUM(CASE WHEN l.direction = 'credit' THEN l.amount_cents ELSE -l.amount_cents END)
    FROM ledger_entries l WHERE l.account_id = a.id), 0)`);
const report = await reconcile(db);
if (!report.ok) {
  console.error('seed left the ledger unbalanced', report);
  process.exit(1);
}

console.log(`seeded ${created.length} users and ${written} bulk transactions; ledger reconciled`);
console.log(
  'demo logins (password Demo1234!): thandi@demo.co.za, sipho@demo.co.za, admin ops@demo.co.za',
);
await handle.close();
