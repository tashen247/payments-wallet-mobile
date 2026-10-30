import { randomUUID } from 'expo-crypto';
import { useCallback, useRef } from 'react';

/**
 * One Idempotency-Key per user action. Retries of the same action reuse the key, so a flaky
 * network can never cause a second debit; `reset` starts a new action.
 */
export function useIdempotencyKey() {
  const ref = useRef<string | null>(null);
  const current = useCallback(() => (ref.current ??= randomUUID()), []);
  const reset = useCallback(() => {
    ref.current = null;
  }, []);
  return { current, reset };
}

/** Retry an idempotent call on network or server errors, with the same key each time. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  attempts = 3,
  delayMs = 600,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * 2 ** i));
    }
  }
  throw lastError;
}
