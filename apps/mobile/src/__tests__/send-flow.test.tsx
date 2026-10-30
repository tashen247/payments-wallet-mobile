import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { TransactionDto } from '@wallet/shared';
import { api, ApiError } from '../lib/api';
import { confirmWithBiometrics } from '../lib/biometrics';
import { SendScreen } from '../screens/SendScreen';
import { renderWithClient } from './render';

jest.mock('../lib/api', () => {
  const actual = jest.requireActual('../lib/api');
  return {
    ApiError: actual.ApiError,
    api: {
      transfer: jest.fn(),
      wallet: jest.fn(),
      resolveAccount: jest.fn(),
      searchContacts: jest.fn(),
    },
  };
});
jest.mock('../lib/biometrics', () => ({ confirmWithBiometrics: jest.fn() }));
jest.mock('../lib/idempotency', () => {
  const actual = jest.requireActual('../lib/idempotency');
  return {
    ...actual,
    withRetries: (fn: () => Promise<unknown>, isRetryable: (e: unknown) => boolean) =>
      actual.withRetries(fn, isRetryable, 3, 1),
  };
});

const mocked = api as jest.Mocked<typeof api>;
const confirm = confirmWithBiometrics as jest.Mock;
const SIPHO = '3f2b8c1e-8a4d-4b7e-9c1a-2d5e6f7a8b9c';

const completed: TransactionDto = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'transfer',
  status: 'completed',
  direction: 'sent',
  amountCents: 25_000,
  reference: 'Braai',
  counterparty: { accountId: SIPHO, displayName: 'Sipho Dlamini' },
  failureCode: null,
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked.wallet.mockResolvedValue({
    accountId: 'a',
    currency: 'ZAR',
    balanceCents: 100_000,
    frozen: false,
    dailyLimitCents: 500_000,
    sentTodayCents: 0,
  });
  mocked.resolveAccount.mockResolvedValue({ accountId: SIPHO, displayName: 'Sipho Dlamini' });
});

async function fillScannedSend() {
  await renderWithClient(<SendScreen initialTo={SIPHO} />);
  expect(await screen.findByText('Sipho Dlamini')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Amount (R)'), '250');
  await fireEvent.changeText(screen.getByLabelText('Reference'), 'Braai');
  await fireEvent.press(screen.getByRole('button', { name: 'Send R250.00' }));
}

it('confirms with biometrics, sends with an Idempotency-Key and shows completed', async () => {
  confirm.mockResolvedValue(true);
  mocked.transfer.mockResolvedValue(completed);
  await fillScannedSend();
  expect(await screen.findByText('Payment sent')).toBeTruthy();
  expect(confirm).toHaveBeenCalledWith('Send R250.00 to Sipho Dlamini');
  expect(mocked.transfer).toHaveBeenCalledWith(
    { toAccountId: SIPHO, amountCents: 25_000, reference: 'Braai' },
    expect.stringMatching(/^[0-9a-f-]{36}$/),
  );
});

it('does not send when biometric confirmation is declined', async () => {
  confirm.mockResolvedValue(false);
  await fillScannedSend();
  expect(await screen.findByText('Payment not confirmed.')).toBeTruthy();
  expect(mocked.transfer).not.toHaveBeenCalled();
});

it('retries a network failure with the same Idempotency-Key', async () => {
  confirm.mockResolvedValue(true);
  mocked.transfer
    .mockRejectedValueOnce(new ApiError(0, 'INTERNAL', 'No connection'))
    .mockResolvedValueOnce(completed);
  await fillScannedSend();
  expect(await screen.findByText('Payment sent')).toBeTruthy();
  expect(mocked.transfer).toHaveBeenCalledTimes(2);
  const [first, second] = mocked.transfer.mock.calls;
  expect(first![1]).toBe(second![1]);
});

it('shows a clear error for a declined payment and does not retry it', async () => {
  confirm.mockResolvedValue(true);
  mocked.transfer.mockRejectedValue(
    new ApiError(
      422,
      'DAILY_LIMIT_EXCEEDED',
      'This payment would take you over your daily send limit of R5 000.',
    ),
  );
  await fillScannedSend();
  expect(await screen.findByText('Payment failed')).toBeTruthy();
  expect(
    screen.getByText('This payment would take you over your daily send limit of R5 000.'),
  ).toBeTruthy();
  expect(mocked.transfer).toHaveBeenCalledTimes(1);
});

it('lets the sender pick a contact by search', async () => {
  mocked.searchContacts.mockResolvedValue([
    {
      accountId: SIPHO,
      displayName: 'Sipho Dlamini',
      email: 'sipho@demo.co.za',
      phone: '+27821000002',
    },
  ]);
  await renderWithClient(<SendScreen />);
  await fireEvent.changeText(screen.getByLabelText('Recipient'), 'sip');
  await fireEvent.press(await screen.findByRole('button', { name: 'Pay Sipho Dlamini' }));
  await waitFor(() => expect(screen.getByText('Paying')).toBeTruthy());
  expect(mocked.searchContacts).toHaveBeenCalledWith('sip');
});

it('keeps Send disabled until there is a recipient and a valid amount', async () => {
  await renderWithClient(<SendScreen initialTo={SIPHO} />);
  await screen.findByText('Sipho Dlamini');
  await fireEvent.changeText(screen.getByLabelText('Amount (R)'), '12.345');
  expect(screen.getByText('Enter an amount like 250 or 250.50')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
});
