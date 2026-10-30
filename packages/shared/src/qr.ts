import { z } from 'zod';

export const QR_SCHEME = 'paywallet';

export interface ReceiveCode {
  to: string;
  amountCents?: number;
  ref?: string;
}

const Uuid = z.uuid();

/** Build the deep link encoded in a receive QR code. */
export function buildReceiveLink(code: ReceiveCode): string {
  const params = new URLSearchParams({ to: code.to });
  if (code.amountCents !== undefined) params.set('amount', String(code.amountCents));
  if (code.ref) params.set('ref', code.ref);
  return `${QR_SCHEME}://pay?${params.toString()}`;
}

/**
 * Parse a scanned QR payload. Returns null for anything that is not a valid receive code.
 * The result only pre-fills the send screen; the sender always confirms the amount.
 */
export function parseReceiveLink(raw: string): ReceiveCode | null {
  const prefix = `${QR_SCHEME}://pay?`;
  if (!raw.startsWith(prefix)) return null;
  const params = new URLSearchParams(raw.slice(prefix.length));
  const to = params.get('to');
  if (!to || !Uuid.safeParse(to).success) return null;
  const result: ReceiveCode = { to };
  const amount = params.get('amount');
  if (amount !== null) {
    if (!/^\d{1,9}$/.test(amount) || Number(amount) <= 0) return null;
    result.amountCents = Number(amount);
  }
  const ref = params.get('ref');
  if (ref) result.ref = ref.slice(0, 60);
  return result;
}
