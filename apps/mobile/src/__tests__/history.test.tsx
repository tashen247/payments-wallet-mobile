import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { TransactionDto } from '@wallet/shared';
import { api } from '../lib/api';
import { HistoryScreen } from '../screens/HistoryScreen';
import { renderWithClient } from './render';

jest.mock('../lib/api', () => ({ api: { history: jest.fn() }, ApiError: class extends Error {} }));
const history = api.history as jest.Mock;

const tx = (i: number, over: Partial<TransactionDto> = {}): TransactionDto => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  type: 'transfer',
  status: 'completed',
  direction: i % 2 ? 'sent' : 'received',
  amountCents: i * 1000,
  reference: `Ref ${i}`,
  counterparty: {
    accountId: '3f2b8c1e-8a4d-4b7e-9c1a-2d5e6f7a8b9c',
    displayName: 'Lerato Mokoena',
  },
  failureCode: null,
  createdAt: new Date(2026, 9, 30, 12, 0, 0).toISOString(),
  completedAt: null,
  ...over,
});

beforeEach(() => history.mockReset());

it('lists transactions with direction and amount', async () => {
  history.mockResolvedValue({
    items: [tx(1), tx(2), tx(3, { status: 'failed', failureCode: 'INSUFFICIENT_FUNDS' })],
    nextCursor: null,
  });
  await renderWithClient(<HistoryScreen />);
  expect(await screen.findByText('Ref 1 · 30 Oct')).toBeTruthy();
  expect(screen.getByText('−R10.00')).toBeTruthy();
  expect(screen.getByText('+R20.00')).toBeTruthy();
  expect(screen.getByText(/Ref 3 · 30 Oct · failed/)).toBeTruthy();
});

it('shows an empty state', async () => {
  history.mockResolvedValue({ items: [], nextCursor: null });
  await renderWithClient(<HistoryScreen />);
  expect(await screen.findByText('No transactions yet')).toBeTruthy();
});

it('loads the next page with the cursor when scrolled to the end', async () => {
  history
    .mockResolvedValueOnce({ items: [tx(1), tx(2)], nextCursor: 'CURSOR1' })
    .mockResolvedValueOnce({ items: [tx(3)], nextCursor: null });
  await renderWithClient(<HistoryScreen />);
  await screen.findByText('Ref 1 · 30 Oct');
  await fireEvent(screen.getByTestId('history-list'), 'onEndReached');
  expect(await screen.findByText('Ref 3 · 30 Oct')).toBeTruthy();
  expect(history).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'CURSOR1' }));
});

it('filters by direction', async () => {
  history.mockResolvedValue({ items: [], nextCursor: null });
  await renderWithClient(<HistoryScreen />);
  await fireEvent.press(await screen.findByRole('tab', { name: 'Received' }));
  await waitFor(() =>
    expect(history).toHaveBeenLastCalledWith(expect.objectContaining({ filter: 'received' })),
  );
});
