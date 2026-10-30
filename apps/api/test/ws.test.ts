import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { wsChannelForUser } from '@wallet/shared';
import { registerUser, useHarness } from './helpers';

function open(
  url: string,
): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: unknown[] = [];
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('error', reject);
  });
}

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('websocket', () => {
  const h = useHarness();

  it('rejects connections without a valid token', async () => {
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { closed } = await open(`${address.replace('http', 'ws')}/v1/ws?token=bad`);
    expect(await closed).toBe(4401);
  });

  it('delivers messages published for the user, and only that user', async () => {
    const a = await registerUser(h);
    const b = await registerUser(h);
    const address = h.app.server.listening
      ? `http://127.0.0.1:${(h.app.server.address() as { port: number }).port}`
      : await h.app.listen({ port: 0, host: '127.0.0.1' });
    const sa = await open(`${address.replace('http', 'ws')}/v1/ws?token=${a.token}`);
    const sb = await open(`${address.replace('http', 'ws')}/v1/ws?token=${b.token}`);
    await waitFor(() => sa.messages.length === 1 && sb.messages.length === 1);
    expect(sa.messages[0]).toEqual({ type: 'hello', userId: a.userId });

    const msg = {
      type: 'wallet.changed',
      eventType: 'transfer.completed',
      transactionId: null,
      paymentRequestId: null,
      amountCents: 25_000,
    };
    await h.redis.publish(wsChannelForUser(a.userId), JSON.stringify(msg));
    await waitFor(() => sa.messages.length === 2);
    expect(sa.messages[1]).toEqual(msg);
    await new Promise((r) => setTimeout(r, 100));
    expect(sb.messages).toHaveLength(1);
    sa.ws.close();
    sb.ws.close();
  });
});
