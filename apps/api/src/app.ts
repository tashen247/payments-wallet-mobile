import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import type { Db } from '@wallet/db';
import type { ErrorBody } from '@wallet/shared';
import type { Config } from './config';
import { AppError } from './lib/errors';
import authPlugin from './plugins/auth';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { paymentRequestRoutes } from './routes/payment-requests';
import { walletRoutes } from './routes/wallet';
import { wsRoutes } from './routes/ws';
import { WsHub } from './ws/hub';

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
}

export interface BuildOptions extends AppDeps {
  /** Separate connection for pub/sub (a subscribed Redis connection cannot run other commands). */
  redisSub: Redis;
  logger?: boolean | object;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config, db, redis } = opts;
  const app = Fastify({
    logger: opts.logger ?? { level: config.LOG_LEVEL },
    requestIdHeader: 'x-correlation-id',
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    let body: ErrorBody;
    let status: number;
    if (err instanceof AppError) {
      status = err.statusCode;
      body = { code: err.code, message: err.message, details: err.details };
    } else if (hasZodFastifySchemaValidationErrors(err)) {
      status = 400;
      body = {
        code: 'VALIDATION_FAILED',
        message: 'Some of the details are not valid.',
        details: err.validation,
      };
    } else if (err.statusCode === 429) {
      status = 429;
      body = { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a moment.' };
    } else if (err.statusCode && err.statusCode < 500) {
      status = err.statusCode;
      body = { code: 'VALIDATION_FAILED', message: err.message };
    } else {
      req.log.error({ err }, 'unhandled error');
      status = 500;
      body = { code: 'INTERNAL', message: 'Something went wrong.' };
    }
    if (body.details === undefined) delete body.details;
    return reply.code(status).send(body);
  });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, {
    global: false,
    redis: config.RATE_LIMIT_ENABLED ? redis : undefined,
    hook: 'preHandler',
    keyGenerator: (req) => (req.user as { sub?: string } | undefined)?.sub ?? req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Too many attempts. Try again in ${ctx.after}.`,
    }),
    allowList: () => !config.RATE_LIMIT_ENABLED,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Payments Wallet API',
        version: '1.0.0',
        description: 'ZAR wallet: double-entry ledger, idempotent transfers, live updates.',
      },
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(authPlugin, { secret: config.JWT_SECRET, accessTtl: config.ACCESS_TOKEN_TTL });
  await app.register(websocket);

  const hub = new WsHub(opts.redisSub, app.log);
  await hub.start();
  app.addHook('onClose', async () => hub.stop());

  app.get('/health', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      await redis.ping();
      return { status: 'ok', wsConnections: hub.connectionCount() };
    } catch (err) {
      app.log.error({ err }, 'health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  const deps: AppDeps = { config, db, redis };
  await app.register(authRoutes, deps);
  await app.register(walletRoutes, deps);
  await app.register(paymentRequestRoutes, deps);
  await app.register(adminRoutes, deps);
  await app.register(wsRoutes, { hub });

  return app;
}
