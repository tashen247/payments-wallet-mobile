import { z } from 'zod';

export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_FUNDS',
  'DAILY_LIMIT_EXCEEDED',
  'ACCOUNT_FROZEN',
  'SELF_TRANSFER',
  'RECIPIENT_NOT_FOUND',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_NOT_PENDING',
  'NOT_DEAD_LETTERED',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Business failures that are recorded on the transaction so idempotent retries return the same result. */
export const PostingFailureCode = z.enum([
  'INSUFFICIENT_FUNDS',
  'DAILY_LIMIT_EXCEEDED',
  'ACCOUNT_FROZEN',
  'SELF_TRANSFER',
  'REQUEST_NOT_PENDING',
]);
export type PostingFailureCode = z.infer<typeof PostingFailureCode>;

export const errorMessages: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Some of the details are not valid.',
  UNAUTHORIZED: 'Please log in again.',
  FORBIDDEN: 'You do not have access to this.',
  NOT_FOUND: 'Not found.',
  EMAIL_TAKEN: 'An account with this email already exists.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  INSUFFICIENT_FUNDS: 'You do not have enough money for this payment.',
  DAILY_LIMIT_EXCEEDED: 'This payment would take you over your daily send limit of R5 000.',
  ACCOUNT_FROZEN: 'This account is frozen. Contact support.',
  SELF_TRANSFER: 'You cannot send money to yourself.',
  RECIPIENT_NOT_FOUND: 'We could not find that recipient.',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key header is required.',
  IDEMPOTENCY_KEY_REUSED: 'This Idempotency-Key was already used for a different request.',
  REQUEST_NOT_PENDING: 'This payment request has already been paid or declined.',
  NOT_DEAD_LETTERED: 'This event is not dead-lettered.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment.',
  INTERNAL: 'Something went wrong.',
};
