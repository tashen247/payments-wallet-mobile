import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { AppError } from './errors';
import { sha256 } from './password';

const Key = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

export function requireIdempotencyKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  const parsed = Key.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Idempotency-Key must be 8-100 URL-safe characters',
    );
  return parsed.data;
}

/** Stable hash of the operation and its parameters, so a reused key with a different body is detected. */
export function requestHash(operation: string, body: Record<string, unknown>): string {
  const sorted = Object.keys(body)
    .sort()
    .map((k) => [k, body[k]]);
  return sha256(JSON.stringify([operation, sorted]));
}
