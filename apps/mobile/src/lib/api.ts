import type {
  AdminAccountDto,
  AdminTransactionDto,
  AuthResponse,
  ContactDto,
  CreatePaymentRequestBody,
  DeadLetterDto,
  ErrorBody,
  HistoryPage,
  LoginBody,
  PaymentRequestDto,
  RegisterBody,
  TransactionDto,
  TransferBody,
  UserDto,
  WalletDto,
} from '@wallet/shared';
import { errorMessages } from '@wallet/shared';
import { API_URL } from './config';
import { useSession } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorBody['code'],
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  /** Network failures and 5xx can be retried with the same Idempotency-Key. */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
  auth?: boolean;
}

let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  const { refreshToken, setTokens, setUser, signOut } = useSession.getState();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      await signOut();
      return false;
    }
    const auth = (await res.json()) as AuthResponse;
    await setTokens(auth.accessToken, auth.refreshToken);
    setUser(auth.user);
    return true;
  } catch {
    return false;
  }
}

export async function request<T>(
  path: string,
  opts: RequestOptions = {},
  retried = false,
): Promise<T> {
  const { accessToken } = useSession.getState();
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'INTERNAL', 'No connection. Check your network and try again.');
  }

  if (res.status === 401 && opts.auth !== false && !retried) {
    refreshing ??= refreshTokens().finally(() => (refreshing = null));
    if (await refreshing) return request<T>(path, opts, true);
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json ?? {}) as Partial<ErrorBody>;
    const code = err.code ?? 'INTERNAL';
    throw new ApiError(
      res.status,
      code,
      err.message ?? errorMessages[code] ?? 'Something went wrong.',
      err.details,
    );
  }
  return json as T;
}

const post = <T>(path: string, body?: unknown, idempotencyKey?: string) =>
  request<T>(path, { method: 'POST', body, idempotencyKey });

export const api = {
  login: (body: LoginBody) =>
    request<AuthResponse>('/v1/auth/login', { method: 'POST', body, auth: false }),
  register: (body: RegisterBody) =>
    request<AuthResponse>('/v1/auth/register', { method: 'POST', body, auth: false }),
  me: () => request<UserDto>('/v1/me'),
  wallet: () => request<WalletDto>('/v1/wallet'),
  topUp: (amountCents: number, key: string) =>
    post<TransactionDto>('/v1/topups', { amountCents }, key),
  transfer: (body: TransferBody, key: string) => post<TransactionDto>('/v1/transfers', body, key),
  history: (params: { filter?: string; q?: string; cursor?: string | null; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params.filter && params.filter !== 'all') qs.set('filter', params.filter);
    if (params.q) qs.set('q', params.q);
    if (params.cursor) qs.set('cursor', params.cursor);
    qs.set('limit', String(params.limit ?? 20));
    return request<HistoryPage>(`/v1/transfers?${qs.toString()}`);
  },
  transaction: (id: string) => request<TransactionDto>(`/v1/transfers/${id}`),
  searchContacts: (q: string) =>
    request<ContactDto[]>(`/v1/contacts/search?q=${encodeURIComponent(q)}`),
  resolveAccount: (accountId: string) =>
    request<{ accountId: string; displayName: string }>(`/v1/contacts/${accountId}`),
  requests: () => request<PaymentRequestDto[]>('/v1/payment-requests'),
  createRequest: (body: CreatePaymentRequestBody) =>
    post<PaymentRequestDto>('/v1/payment-requests', body),
  payRequest: (id: string, key: string) =>
    post<TransactionDto>(`/v1/payment-requests/${id}/pay`, undefined, key),
  declineRequest: (id: string) => post<PaymentRequestDto>(`/v1/payment-requests/${id}/decline`),
  registerDevice: (pushToken: string, platform: 'ios' | 'android') =>
    post<void>('/v1/devices', { pushToken, platform }),
  admin: {
    transfers: (status?: string) =>
      request<AdminTransactionDto[]>(`/v1/admin/transfers${status ? `?status=${status}` : ''}`),
    deadLetters: () => request<DeadLetterDto[]>('/v1/admin/dead-letters'),
    replay: (id: string) => post<{ status: 'queued' }>(`/v1/admin/dead-letters/${id}/replay`),
    accounts: (q?: string) =>
      request<AdminAccountDto[]>(`/v1/admin/accounts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    setFrozen: (accountId: string, frozen: boolean) =>
      post<{ accountId: string; frozen: boolean }>(
        `/v1/admin/accounts/${accountId}/${frozen ? 'freeze' : 'unfreeze'}`,
      ),
  },
};

export type Api = typeof api;
