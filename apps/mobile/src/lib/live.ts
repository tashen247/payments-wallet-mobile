import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { WsServerMessage } from '@wallet/shared';
import { WS_URL } from './config';
import { useSession } from './session';

export const queryKeys = {
  wallet: ['wallet'] as const,
  history: ['history'] as const,
  requests: ['requests'] as const,
  transaction: (id: string) => ['transaction', id] as const,
};

/** Applies a server push to the cache. Exported for tests. */
export function handleLiveMessage(
  raw: string,
  client: QueryClient,
  onMoneyIn?: () => void,
): boolean {
  let parsed: WsServerMessage;
  try {
    parsed = WsServerMessage.parse(JSON.parse(raw));
  } catch {
    return false;
  }
  if (parsed.type !== 'wallet.changed') return false;
  void client.invalidateQueries({ queryKey: queryKeys.wallet });
  void client.invalidateQueries({ queryKey: queryKeys.history });
  if (parsed.transactionId)
    void client.invalidateQueries({ queryKey: queryKeys.transaction(parsed.transactionId) });
  if (parsed.eventType.startsWith('payment_request') || parsed.paymentRequestId) {
    void client.invalidateQueries({ queryKey: queryKeys.requests });
  }
  onMoneyIn?.();
  return true;
}

/** Keeps a WebSocket open while signed in and foregrounded, reconnecting with backoff. */
export function useLiveUpdates() {
  const client = useQueryClient();
  const accessToken = useSession((s) => s.accessToken);

  useEffect(() => {
    if (!accessToken) return;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(
        `${WS_URL}?token=${encodeURIComponent(useSession.getState().accessToken ?? '')}`,
      );
      socket.onopen = () => {
        attempt = 0;
        ping = setInterval(
          () => socket?.readyState === WebSocket.OPEN && socket.send('ping'),
          25_000,
        );
        // Catch up on anything missed while disconnected.
        void client.invalidateQueries({ queryKey: queryKeys.wallet });
      };
      socket.onmessage = (e) => {
        if (typeof e.data === 'string' && e.data !== 'pong') {
          handleLiveMessage(
            e.data,
            client,
            () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
          );
        }
      };
      socket.onclose = () => {
        clearInterval(ping);
        if (stopped) return;
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++));
      };
    };

    connect();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && socket?.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        attempt = 0;
        connect();
      }
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      sub.remove();
      socket?.close();
    };
  }, [accessToken, client]);
}
