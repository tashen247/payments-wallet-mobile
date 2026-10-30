/** All amounts are integer cents. These helpers never use floating point for stored values. */

export const DAILY_SEND_LIMIT_CENTS = 500_000; // R5 000
export const MAX_SINGLE_AMOUNT_CENTS = 10_000_000; // R100 000 per operation (sanity cap)
export const CURRENCY = 'ZAR' as const;

/** Parse a user-entered rand amount like "250", "250.5" or "1 250,75" into cents. */
export function parseRandToCents(input: string): number | null {
  const cleaned = input.replace(/[\sR]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Format cents as South African rand, e.g. 125075 -> "R1 250.75". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${sign}R${whole}.${frac}`;
}
