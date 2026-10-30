import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AuthResponse,
  ErrorBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  UserDto,
} from '@wallet/shared';
import type { AppDeps } from '../app';
import {
  issueRefreshToken,
  login,
  register,
  rotateRefreshToken,
  toUserDto,
} from '../services/auth';
import { eq } from 'drizzle-orm';
import { users } from '@wallet/db';
import { AppError } from '../lib/errors';

const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const authRoutes: FastifyPluginAsyncZod<AppDeps> = async (app, { db, config }) => {
  const tokensFor = async (user: Parameters<typeof toUserDto>[0]) => ({
    user: toUserDto(user),
    accessToken: app.jwt.sign({ sub: user.id, role: user.role, name: user.displayName }),
    refreshToken: (await issueRefreshToken(db, user.id, config.REFRESH_TOKEN_TTL_DAYS)).token,
  });

  app.post(
    '/v1/auth/register',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        body: RegisterBody,
        response: { 201: AuthResponse, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      const user = await register(db, req.body);
      return reply.code(201).send(await tokensFor(user));
    },
  );

  app.post(
    '/v1/auth/login',
    {
      config: authRateLimit,
      schema: { tags: ['auth'], body: LoginBody, response: { 200: AuthResponse, 401: ErrorBody } },
    },
    async (req) => tokensFor(await login(db, req.body.email, req.body.password)),
  );

  app.post(
    '/v1/auth/refresh',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        body: RefreshBody,
        response: { 200: AuthResponse, 401: ErrorBody },
      },
    },
    async (req) => {
      const { user, refreshToken } = await rotateRefreshToken(
        db,
        req.body.refreshToken,
        config.REFRESH_TOKEN_TTL_DAYS,
      );
      if (user.status !== 'active') throw new AppError(401, 'UNAUTHORIZED');
      return {
        user: toUserDto(user),
        accessToken: app.jwt.sign({ sub: user.id, role: user.role, name: user.displayName }),
        refreshToken,
      };
    },
  );

  app.get(
    '/v1/me',
    {
      onRequest: [app.authenticate],
      schema: { tags: ['auth'], security: [{ bearer: [] }], response: { 200: UserDto } },
    },
    async (req) => {
      const [user] = await db.select().from(users).where(eq(users.id, req.user.sub));
      if (!user) throw new AppError(401, 'UNAUTHORIZED');
      return toUserDto(user);
    },
  );
};
