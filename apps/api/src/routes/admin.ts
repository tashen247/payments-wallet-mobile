import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { reconcile } from '@wallet/db';
import {
  AdminAccountDto,
  AdminTransactionDto,
  AdminTransferQuery,
  DeadLetterDto,
  ErrorBody,
} from '@wallet/shared';
import type { AppDeps } from '../app';
import {
  listAccounts,
  listDeadLetters,
  listTransactions,
  replayDeadLetter,
  setFrozen,
} from '../services/admin';

const security = [{ bearer: [] }];
const Id = z.object({ id: z.uuid() });

export const adminRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { db }) => {
  app.addHook('onRequest', app.requireAdmin);

  app.get(
    '/v1/admin/transfers',
    {
      schema: {
        tags: ['admin'],
        security,
        querystring: AdminTransferQuery,
        response: { 200: z.array(AdminTransactionDto) },
      },
    },
    async (req) => listTransactions(db, req.query.status, req.query.limit),
  );

  app.get(
    '/v1/admin/dead-letters',
    { schema: { tags: ['admin'], security, response: { 200: z.array(DeadLetterDto) } } },
    async () => listDeadLetters(db),
  );

  app.post(
    '/v1/admin/dead-letters/:id/replay',
    {
      schema: {
        tags: ['admin'],
        security,
        params: Id,
        response: { 202: z.object({ status: z.literal('queued') }), 409: ErrorBody },
      },
    },
    async (req, reply) => {
      await replayDeadLetter(db, req.user.sub, req.params.id);
      return reply.code(202).send({ status: 'queued' as const });
    },
  );

  app.get(
    '/v1/admin/accounts',
    {
      schema: {
        tags: ['admin'],
        security,
        querystring: z.object({ q: z.string().trim().max(60).optional() }),
        response: { 200: z.array(AdminAccountDto) },
      },
    },
    async (req) => listAccounts(db, req.query.q),
  );

  for (const [action, frozen] of [
    ['freeze', true],
    ['unfreeze', false],
  ] as const) {
    app.post(
      `/v1/admin/accounts/:id/${action}`,
      {
        schema: {
          tags: ['admin'],
          security,
          params: Id,
          response: { 200: z.object({ accountId: z.uuid(), frozen: z.boolean() }), 404: ErrorBody },
        },
      },
      async (req) => {
        await setFrozen(db, req.user.sub, req.params.id, frozen);
        return { accountId: req.params.id, frozen };
      },
    );
  }

  app.get('/v1/admin/reconciliation', { schema: { tags: ['admin'], security } }, async () =>
    reconcile(db),
  );
};
