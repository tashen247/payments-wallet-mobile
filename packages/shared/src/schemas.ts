import { z } from 'zod';
import { MAX_SINGLE_AMOUNT_CENTS } from './money';

export const AmountCents = z.number().int().positive().max(MAX_SINGLE_AMOUNT_CENTS);
export const Reference = z.string().trim().max(60);

// ---------- Auth ----------
export const Role = z.enum(['holder', 'admin']);
export type Role = z.infer<typeof Role>;

export const RegisterBody = z.object({
  email: z.email().toLowerCase(),
  phone: z
    .string()
    .regex(/^(\+27|0)\d{9}$/, 'South African number, e.g. 0821234567')
    .transform((p) => (p.startsWith('0') ? `+27${p.slice(1)}` : p)),
  displayName: z.string().trim().min(2).max(60),
  password: z.string().min(8).max(128),
});
export type RegisterBody = z.input<typeof RegisterBody>;

export const LoginBody = z.object({ email: z.email().toLowerCase(), password: z.string().min(1) });
export type LoginBody = z.infer<typeof LoginBody>;

export const RefreshBody = z.object({ refreshToken: z.string().min(10) });

export const UserDto = z.object({
  id: z.uuid(),
  email: z.string(),
  phone: z.string(),
  displayName: z.string(),
  role: Role,
});
export type UserDto = z.infer<typeof UserDto>;

export const AuthResponse = z.object({
  user: UserDto,
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

// ---------- Wallet ----------
export const WalletDto = z.object({
  accountId: z.uuid(),
  currency: z.literal('ZAR'),
  balanceCents: z.number().int(),
  frozen: z.boolean(),
  dailyLimitCents: z.number().int(),
  sentTodayCents: z.number().int(),
});
export type WalletDto = z.infer<typeof WalletDto>;

// ---------- Transactions ----------
export const TransactionType = z.enum(['topup', 'transfer', 'request_payment']);
export const TransactionStatus = z.enum(['pending', 'completed', 'failed']);
export type TransactionStatus = z.infer<typeof TransactionStatus>;
export const Direction = z.enum(['sent', 'received', 'topup']);

export const TransactionDto = z.object({
  id: z.uuid(),
  type: TransactionType,
  status: TransactionStatus,
  direction: Direction,
  amountCents: z.number().int(),
  reference: z.string(),
  counterparty: z.object({ accountId: z.uuid(), displayName: z.string() }).nullable(),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type TransactionDto = z.infer<typeof TransactionDto>;

export const TopupBody = z.object({ amountCents: AmountCents });
export type TopupBody = z.infer<typeof TopupBody>;

export const TransferBody = z.object({
  toAccountId: z.uuid(),
  amountCents: AmountCents,
  reference: Reference.default(''),
});
export type TransferBody = z.input<typeof TransferBody>;

export const HistoryQuery = z.object({
  filter: z.enum(['all', 'sent', 'received', 'topup']).default('all'),
  q: z.string().trim().max(60).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type HistoryQuery = z.input<typeof HistoryQuery>;

export const HistoryPage = z.object({
  items: z.array(TransactionDto),
  nextCursor: z.string().nullable(),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

// ---------- Payment requests ----------
export const PaymentRequestStatus = z.enum(['pending', 'paid', 'declined']);
export const CreatePaymentRequestBody = z.object({
  toAccountId: z.uuid(),
  amountCents: AmountCents,
  reference: Reference.default(''),
});
export type CreatePaymentRequestBody = z.input<typeof CreatePaymentRequestBody>;

export const PaymentRequestDto = z.object({
  id: z.uuid(),
  direction: z.enum(['incoming', 'outgoing']),
  amountCents: z.number().int(),
  reference: z.string(),
  status: PaymentRequestStatus,
  counterparty: z.object({ accountId: z.uuid(), displayName: z.string() }),
  createdAt: z.string(),
});
export type PaymentRequestDto = z.infer<typeof PaymentRequestDto>;

// ---------- Contacts ----------
export const ContactDto = z.object({
  accountId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  phone: z.string(),
});
export type ContactDto = z.infer<typeof ContactDto>;

// ---------- Devices ----------
export const RegisterDeviceBody = z.object({
  pushToken: z.string().min(10).max(200),
  platform: z.enum(['ios', 'android']),
});

// ---------- Admin ----------
export const AdminTransferQuery = z.object({
  status: TransactionStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const AdminTransactionDto = z.object({
  id: z.uuid(),
  type: TransactionType,
  status: TransactionStatus,
  amountCents: z.number().int(),
  reference: z.string(),
  fromName: z.string().nullable(),
  toName: z.string().nullable(),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminTransactionDto = z.infer<typeof AdminTransactionDto>;

export const DeadLetterDto = z.object({
  id: z.uuid(),
  type: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  correlationId: z.string().nullable(),
});
export type DeadLetterDto = z.infer<typeof DeadLetterDto>;

export const AdminAccountDto = z.object({
  accountId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  frozen: z.boolean(),
  balanceCents: z.number().int(),
});
export type AdminAccountDto = z.infer<typeof AdminAccountDto>;
