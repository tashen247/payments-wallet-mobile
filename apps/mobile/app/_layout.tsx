import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PinPrompt } from '../src/components/PinPrompt';
import { Loading } from '../src/components/ui';
import { api, ApiError } from '../src/lib/api';
import { useLiveUpdates } from '../src/lib/live';
import { usePushNotifications } from '../src/lib/push';
import { useSession } from '../src/lib/session';
import { LockScreen } from '../src/screens/LockScreen';
import { useTheme } from '../src/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      staleTime: 10_000,
    },
  },
});

/** Re-lock after this long in the background. */
const LOCK_AFTER_MS = 60_000;

function Gate() {
  const t = useTheme();
  const segments = useSegments();
  const { status, unlocked, user, hydrate, setUser, setUnlocked, signOut } = useSession();
  const backgroundedAt = useRef<number | null>(null);

  useLiveUpdates();
  usePushNotifications();

  useEffect(() => {
    void hydrate().then(async (tokens) => {
      if (!tokens) return;
      try {
        setUser(await api.me());
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) await signOut();
      }
    });
  }, [hydrate, setUser, signOut]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgroundedAt.current = Date.now();
      if (
        state === 'active' &&
        backgroundedAt.current &&
        Date.now() - backgroundedAt.current > LOCK_AFTER_MS
      )
        setUnlocked(false);
    });
    return () => sub.remove();
  }, [setUnlocked]);

  if (status === 'loading') return <Loading />;
  const inAuth = segments[0] === '(auth)';
  if (status === 'signedOut' && !inAuth) return <Redirect href="/login" />;
  if (status === 'signedIn' && !unlocked) return <LockScreen />;
  if (status === 'signedIn' && inAuth) return <Redirect href="/" />;

  // Money screens are pushed, not presented as native modals: on iOS a React Native <Modal> (the PIN
  // prompt, mounted at the root) cannot appear above a natively presented sheet.
  const header = {
    headerStyle: { backgroundColor: t.bg },
    headerTintColor: t.text,
    headerShadowVisible: false,
  };
  return (
    <Stack screenOptions={{ ...header, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="send" options={{ title: 'Send money' }} />
      <Stack.Screen name="scan" options={{ title: 'Scan to pay' }} />
      <Stack.Screen name="topup" options={{ title: 'Top up' }} />
      <Stack.Screen name="request-new" options={{ title: 'Request money' }} />
      <Stack.Screen name="transaction/[id]" options={{ title: 'Transaction' }} />
      <Stack.Screen name="pay" options={{ headerShown: false }} />
      <Stack.Screen
        name="admin/transfers"
        options={{ title: 'Transfers', headerShown: user?.role === 'admin' }}
      />
      <Stack.Screen name="admin/dead-letters" options={{ title: 'Dead letters' }} />
      <Stack.Screen name="admin/accounts" options={{ title: 'Accounts' }} />
    </Stack>
  );
}

export default function RootLayout() {
  const t = useTheme();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.bg }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="auto" />
          <Gate />
          <PinPrompt />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
