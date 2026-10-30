import { QueryClient } from '@tanstack/react-query';
import { handleLiveMessage, queryKeys } from '../lib/live';

jest.mock('../lib/session', () => ({ useSession: () => null }));

function setup() {
  const client = new QueryClient();
  const spy = jest.spyOn(client, 'invalidateQueries');
  const onMoneyIn = jest.fn();
  return { client, spy, onMoneyIn };
}

it('refreshes the balance, history and the transaction when money arrives', () => {
  const { client, spy, onMoneyIn } = setup();
  const msg = {
    type: 'wallet.changed',
    eventType: 'transfer.completed',
    transactionId: '11111111-1111-4111-8111-111111111111',
    paymentRequestId: null,
    amountCents: 25_000,
  };
  expect(handleLiveMessage(JSON.stringify(msg), client, onMoneyIn)).toBe(true);
  const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
  expect(keys).toEqual(
    expect.arrayContaining([
      queryKeys.wallet,
      queryKeys.history,
      queryKeys.transaction(msg.transactionId),
    ]),
  );
  expect(keys).not.toContainEqual(queryKeys.requests);
  expect(onMoneyIn).toHaveBeenCalled();
});

it('refreshes requests for payment-request events', () => {
  const { client, spy } = setup();
  handleLiveMessage(
    JSON.stringify({
      type: 'wallet.changed',
      eventType: 'payment_request.created',
      transactionId: null,
      paymentRequestId: '22222222-2222-4222-8222-222222222222',
      amountCents: 100,
    }),
    client,
  );
  expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(queryKeys.requests);
});

it('ignores hello messages and garbage', () => {
  const { client, spy } = setup();
  expect(
    handleLiveMessage(
      JSON.stringify({ type: 'hello', userId: '11111111-1111-4111-8111-111111111111' }),
      client,
    ),
  ).toBe(false);
  expect(handleLiveMessage('not json', client)).toBe(false);
  expect(handleLiveMessage(JSON.stringify({ type: 'wallet.changed' }), client)).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});
