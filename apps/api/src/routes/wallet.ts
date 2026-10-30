import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { deviceTokens } from '@wallet/db';
import {
  ContactDto,
  DAILY_SEND_LIMIT_CENTS,
  ErrorBody,
  HistoryPage,
  HistoryQuery,
  RegisterDeviceBody,
  TopupBody,
  TransactionDto,
  TransferBody,
  WalletDto,
} from '@wallet/shared';
import type { AppDeps } from '../app';
import { AppError } from '../lib/errors';
import { requireIdempotencyKey } from '../lib/idempotency';
import { findUserByAccountId, getUserAccount, searchContacts } from '../services/accounts';
import { getTransactionForAccount, listHistory } from '../services/history';
import { topUp, transfer, type MoneyContext } from '../services/money';
import { sentTodayCents } from '../services/posting';

const moneyRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const security = [{ bearer: [] }];
const IdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .optional()
    .describe('Required. A UUID per user action, reused on every retry of that action.'),
});
const moneyErrors = {
  400: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  423: ErrorBody,
};

export const walletRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate);

  const ctx = (req: Parameters<typeof requireIdempotencyKey>[0]): MoneyContext => ({
    userId: req.user.sub,
    displayName: req.user.name,
    idempotencyKey: requireIdempotencyKey(req),
    correlationId: req.id,
  });

  app.get(
    '/v1/wallet',
    { schema: { tags: ['wallet'], security, response: { 200: WalletDto } } },
    async (req) => {
      const account = await getUserAccount(db, req.user.sub);
      return {
        accountId: account.id,
        currency: 'ZAR' as const,
        balanceCents: account.balanceCents,
        frozen: account.frozen,
        dailyLimitCents: DAILY_SEND_LIMIT_CENTS,
        sentTodayCents: await sentTodayCents(db, account.id),
      };
    },
  );

  app.post(
    '/v1/topups',
    {
      config: moneyRateLimit,
      schema: {
        tags: ['wallet'],
        security,
        headers: IdempotencyHeaders,
        body: TopupBody,
        response: { 201: TransactionDto, ...moneyErrors },
      },
    },
    async (req, reply) => {
      const result = await topUp(db, ctx(req), req.body.amountCents);
      return reply
        .code(201)
        .header('idempotent-replayed', String(result.replayed))
        .send(result.transaction);
    },
  );

  app.post(
    '/v1/transfers',
    {
      config: moneyRateLimit,
      schema: {
        tags: ['transfers'],
        security,
        headers: IdempotencyHeaders,
        body: TransferBody,
        response: { 201: TransactionDto, ...moneyErrors },
      },
    },
    async (req, reply) => {
      const result = await transfer(db, ctx(req), req.body);
      return reply
        .code(201)
        .header('idempotent-replayed', String(result.replayed))
        .send(result.transaction);
    },
  );

  app.get(
    '/v1/transfers',
    {
      schema: {
        tags: ['transfers'],
        security,
        querystring: HistoryQuery,
        response: { 200: HistoryPage },
      },
    },
    async (req) => {
      const account = await getUserAccount(db, req.user.sub);
      return listHistory(db, account.id, req.query);
    },
  );

  app.get(
    '/v1/transfers/:id',
    {
      schema: {
        tags: ['transfers'],
        security,
        params: z.object({ id: z.uuid() }),
        response: { 200: TransactionDto, 404: ErrorBody },
      },
    },
    async (req) => {
      const account = await getUserAccount(db, req.user.sub);
      return getTransactionForAccount(db, account.id, req.params.id);
    },
  );

  app.get(
    '/v1/contacts/search',
    {
      schema: {
        tags: ['contacts'],
        security,
        querystring: z.object({ q: z.string().trim().min(2).max(60) }),
        response: { 200: z.array(ContactDto) },
      },
    },
    async (req) => searchContacts(db, req.user.sub, req.query.q),
  );

  app.get(
    '/v1/contacts/:accountId',
    {
      schema: {
        tags: ['contacts'],
        security,
        params: z.object({ accountId: z.uuid() }),
        response: {
          200: z.object({ accountId: z.uuid(), displayName: z.string() }),
          404: ErrorBody,
        },
      },
    },
    async (req) => {
      const found = await findUserByAccountId(db, req.params.accountId);
      if (!found) throw new AppError(404, 'RECIPIENT_NOT_FOUND');
      return { accountId: found.accountId, displayName: found.displayName };
    },
  );

  app.post(
    '/v1/devices',
    {
      schema: {
        tags: ['devices'],
        security,
        body: RegisterDeviceBody,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      await db
        .insert(deviceTokens)
        .values({ userId: req.user.sub, token: req.body.pushToken, platform: req.body.platform })
        .onConflictDoUpdate({
          target: deviceTokens.token,
          set: { userId: req.user.sub, platform: req.body.platform, createdAt: sql`now()` },
        });
      return reply.code(204).send(null);
    },
  );
};
