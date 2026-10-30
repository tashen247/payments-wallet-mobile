import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['holder', 'admin']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled']);
export const accountTypeEnum = pgEnum('account_type', ['user', 'system']);
export const txTypeEnum = pgEnum('transaction_type', ['topup', 'transfer', 'request_payment']);
export const txStatusEnum = pgEnum('transaction_status', ['pending', 'completed', 'failed']);
export const directionEnum = pgEnum('ledger_direction', ['debit', 'credit']);
export const requestStatusEnum = pgEnum('payment_request_status', ['pending', 'paid', 'declined']);
export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'sent', 'dead']);

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const cents = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  phone: text('phone').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull().default('holder'),
  status: userStatusEnum('status').notNull().default('active'),
  createdAt: createdAt(),
});

/**
 * balance_cents is a projection of the ledger. Only the posting service writes it, in the same
 * database transaction as the ledger entries; the reconciliation check proves it matches.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    type: accountTypeEnum('type').notNull(),
    userId: uuid('user_id').references(() => users.id),
    code: text('code'),
    currency: text('currency').notNull().default('ZAR'),
    frozen: boolean('frozen').notNull().default(false),
    balanceCents: cents('balance_cents').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('accounts_user_id_uq').on(t.userId),
    uniqueIndex('accounts_code_uq').on(t.code),
    check(
      'accounts_owner_ck',
      sql`(${t.type} = 'user' AND ${t.userId} IS NOT NULL AND ${t.code} IS NULL) OR (${t.type} = 'system' AND ${t.userId} IS NULL AND ${t.code} IS NOT NULL)`,
    ),
    check('accounts_user_non_negative_ck', sql`${t.type} = 'system' OR ${t.balanceCents} >= 0`),
  ],
);

export const paymentRequests = pgTable(
  'payment_requests',
  {
    id: id(),
    /** The user asking to be paid. */
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id),
    /** The user being asked to pay. */
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id),
    amountCents: cents('amount_cents').notNull(),
    reference: text('reference').notNull().default(''),
    status: requestStatusEnum('status').notNull().default('pending'),
    transactionId: uuid('transaction_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_requests_to_idx').on(t.toUserId, t.createdAt),
    index('payment_requests_from_idx').on(t.fromUserId, t.createdAt),
    check('payment_requests_amount_ck', sql`${t.amountCents} > 0`),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    id: id(),
    type: txTypeEnum('type').notNull(),
    status: txStatusEnum('status').notNull().default('pending'),
    /** The user who initiated the request; idempotency keys are scoped to this user. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    fromAccountId: uuid('from_account_id')
      .notNull()
      .references(() => accounts.id),
    toAccountId: uuid('to_account_id')
      .notNull()
      .references(() => accounts.id),
    amountCents: cents('amount_cents').notNull(),
    reference: text('reference').notNull().default(''),
    paymentRequestId: uuid('payment_request_id').references(() => paymentRequests.id),
    failureCode: text('failure_code'),
    correlationId: text('correlation_id'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('transactions_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('transactions_from_idx').on(t.fromAccountId, t.createdAt),
    index('transactions_to_idx').on(t.toAccountId, t.createdAt),
    index('transactions_status_idx').on(t.status, t.createdAt),
    check('transactions_amount_ck', sql`${t.amountCents} > 0`),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    direction: directionEnum('direction').notNull(),
    amountCents: cents('amount_cents').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_account_idx').on(t.accountId, t.createdAt),
    index('ledger_entries_tx_idx').on(t.transactionId),
    check('ledger_entries_amount_ck', sql`${t.amountCents} > 0`),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    correlationId: text('correlation_id'),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deadAt: timestamp('dead_at', { withTimezone: true }),
  },
  (t) => [index('outbox_events_status_idx').on(t.status, t.createdAt)],
);

/** Worker de-duplication: one row per event per side effect, so replays never repeat a side effect. */
export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').notNull(),
    handler: text('handler').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.handler] })],
);

export const auditEvents = pgTable('audit_events', {
  id: id(),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  targetId: uuid('target_id'),
  metadata: jsonb('metadata'),
  createdAt: createdAt(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  replacedById: uuid('replaced_by_id'),
  createdAt: createdAt(),
});

export const deviceTokens = pgTable('device_tokens', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  token: text('token').notNull().unique(),
  platform: text('platform').notNull(),
  createdAt: createdAt(),
});
