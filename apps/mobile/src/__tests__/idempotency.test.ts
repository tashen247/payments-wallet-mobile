import { withRetries } from '../lib/idempotency';

it('retries retryable errors and returns the eventual result', async () => {
  const fn = jest
    .fn()
    .mockRejectedValueOnce(new Error('net'))
    .mockRejectedValueOnce(new Error('net'))
    .mockResolvedValue('ok');
  await expect(withRetries(fn, () => true, 3, 1)).resolves.toBe('ok');
  expect(fn).toHaveBeenCalledTimes(3);
});

it('does not retry business errors', async () => {
  const fn = jest.fn().mockRejectedValue(new Error('declined'));
  await expect(withRetries(fn, () => false, 3, 1)).rejects.toThrow('declined');
  expect(fn).toHaveBeenCalledTimes(1);
});

it('gives up after the last attempt', async () => {
  const fn = jest.fn().mockRejectedValue(new Error('net'));
  await expect(withRetries(fn, () => true, 3, 1)).rejects.toThrow('net');
  expect(fn).toHaveBeenCalledTimes(3);
});
