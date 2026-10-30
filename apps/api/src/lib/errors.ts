import type { ErrorCode } from '@wallet/shared';
import { errorMessages } from '@wallet/shared';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? errorMessages[code]);
  }
}

export const notFound = () => new AppError(404, 'NOT_FOUND');
export const forbidden = () => new AppError(403, 'FORBIDDEN');

/** HTTP status for a business failure recorded on a transaction. */
export function statusForFailure(code: string): number {
  switch (code) {
    case 'ACCOUNT_FROZEN':
      return 423;
    case 'REQUEST_NOT_PENDING':
      return 409;
    default:
      return 422;
  }
}
