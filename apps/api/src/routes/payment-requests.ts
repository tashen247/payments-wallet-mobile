import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreatePaymentRequestBody,
  ErrorBody,
  PaymentRequestDto,
  TransactionDto,
} from '@wallet/shared';
import type { AppDeps } from '../app';
import { requireIdempotencyKey } from '../lib/idempotency';
import {
  createRequest,
  declineRequest,
  listRequests,
  payRequest,
} from '../services/payment-requests';

const security = [{ bearer: [] }];
const Params = z.object({ id: z.uuid() });
const errors = { 400: ErrorBody, 404: ErrorBody, 409: ErrorBody, 422: ErrorBody, 423: ErrorBody };

export const paymentRequestRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { db }) => {
  app.addHook('onRequest', app.authenticate);
  const base = (req: { user: { sub: string; name: string }; id: string }) => ({
    userId: req.user.sub,
    displayName: req.user.name,
    correlationId: req.id,
  });

  app.get(
    '/v1/payment-requests',
    {
      schema: {
        tags: ['payment-requests'],
        security,
        response: { 200: z.array(PaymentRequestDto) },
      },
    },
    async (req) => listRequests(db, req.user.sub),
  );

  app.post(
    '/v1/payment-requests',
    {
      schema: {
        tags: ['payment-requests'],
        security,
        body: CreatePaymentRequestBody,
        response: { 201: PaymentRequestDto, ...errors },
      },
    },
    async (req, reply) => reply.code(201).send(await createRequest(db, base(req), req.body)),
  );

  app.post(
    '/v1/payment-requests/:id/pay',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['payment-requests'],
        security,
        params: Params,
        response: { 201: TransactionDto, ...errors },
      },
    },
    async (req, reply) => {
      const result = await payRequest(
        db,
        { ...base(req), idempotencyKey: requireIdempotencyKey(req) },
        req.params.id,
      );
      return reply
        .code(201)
        .header('idempotent-replayed', String(result.replayed))
        .send(result.transaction);
    },
  );

  app.post(
    '/v1/payment-requests/:id/decline',
    {
      schema: {
        tags: ['payment-requests'],
        security,
        params: Params,
        response: { 200: PaymentRequestDto, ...errors },
      },
    },
    async (req) => declineRequest(db, base(req), req.params.id),
  );
};
