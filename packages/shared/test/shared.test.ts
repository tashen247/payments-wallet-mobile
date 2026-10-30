import { describe, expect, it } from 'vitest';
import {
  buildReceiveLink,
  formatCents,
  parseRandToCents,
  parseReceiveLink,
  RegisterBody,
  TransferBody,
} from '../src';

const id = '3f2b8c1e-8a4d-4b7e-9c1a-2d5e6f7a8b9c';

describe('money', () => {
  it('parses rand input into integer cents', () => {
    expect(parseRandToCents('250')).toBe(25000);
    expect(parseRandToCents('250.5')).toBe(25050);
    expect(parseRandToCents('1 250,75')).toBe(125075);
    expect(parseRandToCents('R99.99')).toBe(9999);
    expect(parseRandToCents('0.1')).toBe(10);
  });
  it('rejects invalid input', () => {
    for (const bad of ['', 'abc', '1.234', '-5', '1..2']) expect(parseRandToCents(bad)).toBeNull();
  });
  it('formats cents as rand', () => {
    expect(formatCents(25000)).toBe('R250.00');
    expect(formatCents(125075)).toBe('R1 250.75');
    expect(formatCents(-5)).toBe('-R0.05');
    expect(formatCents(123456789)).toBe('R1 234 567.89');
  });
});

describe('receive QR codes', () => {
  it('round-trips a code with amount and reference', () => {
    const link = buildReceiveLink({ to: id, amountCents: 25000, ref: 'Braai' });
    expect(link.startsWith('paywallet://pay?')).toBe(true);
    expect(parseReceiveLink(link)).toEqual({ to: id, amountCents: 25000, ref: 'Braai' });
  });
  it('accepts a code without amount', () => {
    expect(parseReceiveLink(buildReceiveLink({ to: id }))).toEqual({ to: id });
  });
  it('rejects foreign or malformed codes', () => {
    expect(parseReceiveLink('https://example.com')).toBeNull();
    expect(parseReceiveLink('paywallet://pay?to=not-a-uuid')).toBeNull();
    expect(parseReceiveLink(`paywallet://pay?to=${id}&amount=-1`)).toBeNull();
    expect(parseReceiveLink(`paywallet://pay?to=${id}&amount=12.5`)).toBeNull();
  });
});

describe('schemas', () => {
  it('normalises SA phone numbers', () => {
    const parsed = RegisterBody.parse({
      email: 'Thandi@Example.co.za',
      phone: '0821234567',
      displayName: 'Thandi',
      password: 'password123',
    });
    expect(parsed.phone).toBe('+27821234567');
    expect(parsed.email).toBe('thandi@example.co.za');
  });
  it('rejects non-integer and non-positive amounts', () => {
    expect(TransferBody.safeParse({ toAccountId: id, amountCents: 10.5 }).success).toBe(false);
    expect(TransferBody.safeParse({ toAccountId: id, amountCents: 0 }).success).toBe(false);
    expect(TransferBody.parse({ toAccountId: id, amountCents: 100 }).reference).toBe('');
  });
});
