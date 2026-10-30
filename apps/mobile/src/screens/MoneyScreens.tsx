import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {
  buildReceiveLink,
  formatCents,
  parseRandToCents,
  parseReceiveLink,
  type PaymentRequestDto,
} from '@wallet/shared';
import {
  Button,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  Muted,
  Screen,
  Title,
} from '../components/ui';
import { api, ApiError } from '../lib/api';
import { confirmWithBiometrics } from '../lib/biometrics';
import { useIdempotencyKey, withRetries } from '../lib/idempotency';
import { queryKeys } from '../lib/live';
import { useSession } from '../lib/session';
import { space, useTheme } from '../theme';

const retryable = (err: unknown) => err instanceof ApiError && err.retryable;

export function TopUpScreen() {
  const t = useTheme();
  const client = useQueryClient();
  const idem = useIdempotencyKey();
  const [amount, setAmount] = useState('500');
  const cents = parseRandToCents(amount);
  const topUp = useMutation({
    mutationFn: () => withRetries(() => api.topUp(cents!, idem.current()), retryable),
    onSuccess: () => {
      idem.reset();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void client.invalidateQueries({ queryKey: queryKeys.wallet });
      void client.invalidateQueries({ queryKey: queryKeys.history });
      router.back();
    },
    onError: () => idem.reset(),
  });
  return (
    <Screen>
      <Title>Top up</Title>
      <Muted>This is a simulated card top-up. No real card details are used.</Muted>
      <Field
        label="Amount (R)"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      <Card>
        <Text style={{ color: t.text, fontWeight: '700' }}>Test card</Text>
        <Muted>Visa ending 4242 · always approves</Muted>
      </Card>
      {topUp.error ? (
        <Text style={{ color: t.danger }}>{(topUp.error as Error).message}</Text>
      ) : null}
      <Button
        title={cents ? `Top up ${formatCents(cents)} with test card` : 'Top up'}
        disabled={!cents}
        loading={topUp.isPending}
        onPress={() => topUp.mutate()}
      />
    </Screen>
  );
}

export function ReceiveScreen() {
  const t = useTheme();
  const user = useSession((s) => s.user);
  const wallet = useQuery({ queryKey: queryKeys.wallet, queryFn: api.wallet });
  if (!wallet.data) return <Loading />;
  const link = buildReceiveLink({ to: wallet.data.accountId });
  return (
    <Screen>
      <View style={{ alignItems: 'center', gap: space(4), paddingTop: space(4) }}>
        <Title>Scan to pay {user?.displayName.split(' ')[0] ?? 'me'}</Title>
        <View
          accessibilityLabel="Your receive QR code"
          style={{ backgroundColor: '#fff', padding: space(5), borderRadius: 24 }}
        >
          <QRCode value={link} size={240} color="#0B3D2E" />
        </View>
        <Text style={{ color: t.muted, textAlign: 'center' }}>
          The payer always confirms the amount and their identity before money moves.
        </Text>
      </View>
    </Screen>
  );
}

export function ScanScreen() {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string>();
  const handled = useRef(false);

  if (!permission) return <Loading />;
  if (!permission.granted) {
    return (
      <Screen>
        <Title>Camera access</Title>
        <Muted>Allow the camera to scan someone's receive QR code.</Muted>
        <Button title="Allow camera" onPress={() => void requestPermission()} />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          const code = parseReceiveLink(data);
          if (!code) {
            setError('That is not a wallet QR code.');
            return;
          }
          handled.current = true;
          void Haptics.selectionAsync();
          router.replace({
            pathname: '/send',
            params: {
              to: code.to,
              ...(code.amountCents ? { amount: String(code.amountCents) } : {}),
              ...(code.ref ? { ref: code.ref } : {}),
            },
          });
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: space(10),
          left: space(4),
          right: space(4),
          alignItems: 'center',
        }}
      >
        <Text
          style={{ color: error ? t.accent : '#fff', fontWeight: '600' }}
          accessibilityLiveRegion="polite"
        >
          {error ?? 'Point the camera at a receive QR code'}
        </Text>
      </View>
    </View>
  );
}

const STATUS_STEPS = ['Created', 'Confirmed', 'Completed'] as const;

export function TransactionDetailScreen({ id }: { id: string }) {
  const t = useTheme();
  const tx = useQuery({ queryKey: queryKeys.transaction(id), queryFn: () => api.transaction(id) });
  if (tx.isLoading) return <Loading />;
  if (tx.isError || !tx.data) return <ErrorState message="Transaction not found." />;
  const d = tx.data;
  const steps =
    d.status === 'failed'
      ? [
          { label: 'Created', at: d.createdAt, ok: true },
          {
            label: `Failed: ${d.failureCode?.replace(/_/g, ' ').toLowerCase() ?? 'unknown'}`,
            at: d.completedAt,
            ok: false,
          },
        ]
      : STATUS_STEPS.map((label, i) => ({
          label,
          at: i === 2 ? d.completedAt : d.createdAt,
          ok: i < 2 || d.status === 'completed',
        }));
  return (
    <Screen>
      <Card>
        <Muted>
          {d.direction === 'topup'
            ? 'Top-up'
            : d.direction === 'sent'
              ? `To ${d.counterparty?.displayName}`
              : `From ${d.counterparty?.displayName}`}
        </Muted>
        <Title>{formatCents(d.amountCents)}</Title>
        {d.reference ? <Muted>{d.reference}</Muted> : null}
      </Card>
      <Card>
        <Text style={{ color: t.text, fontWeight: '700' }}>Status</Text>
        {steps.map((s) => (
          <View
            key={s.label}
            style={{ flexDirection: 'row', gap: space(3), alignItems: 'center' }}
            accessibilityLabel={`${s.label}${s.at ? ` at ${new Date(s.at).toLocaleString('en-ZA')}` : ''}`}
          >
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: s.ok ? t.success : t.danger,
              }}
            />
            <Text style={{ color: t.text, flex: 1 }}>{s.label}</Text>
            <Muted>
              {s.at
                ? new Date(s.at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
                : ''}
            </Muted>
          </View>
        ))}
      </Card>
      <Muted>{`Reference id ${d.id.slice(0, 8)}`}</Muted>
    </Screen>
  );
}

function RequestRow({ r }: { r: PaymentRequestDto }) {
  const t = useTheme();
  const client = useQueryClient();
  const idem = useIdempotencyKey();
  const [error, setError] = useState<string>();
  const done = () => {
    void client.invalidateQueries({ queryKey: queryKeys.requests });
    void client.invalidateQueries({ queryKey: queryKeys.wallet });
    void client.invalidateQueries({ queryKey: queryKeys.history });
  };
  const pay = useMutation({
    mutationFn: () => withRetries(() => api.payRequest(r.id, idem.current()), retryable),
    onSuccess: () => {
      idem.reset();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      done();
    },
    onError: (err) => {
      idem.reset();
      setError((err as Error).message);
    },
  });
  const decline = useMutation({
    mutationFn: () => api.declineRequest(r.id),
    onSuccess: done,
    onError: (err) => setError((err as Error).message),
  });
  const incoming = r.direction === 'incoming';
  return (
    <Card>
      <Text style={{ color: t.text, fontWeight: '700' }}>
        {incoming
          ? `${r.counterparty.displayName} requested`
          : `You requested from ${r.counterparty.displayName}`}
      </Text>
      <Title>{formatCents(r.amountCents)}</Title>
      <Muted>{[r.reference, r.status].filter(Boolean).join(' · ')}</Muted>
      {error ? <Text style={{ color: t.danger }}>{error}</Text> : null}
      {incoming && r.status === 'pending' ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <View style={{ flex: 1 }}>
            <Button
              title="Pay"
              loading={pay.isPending}
              onPress={async () => {
                if (
                  await confirmWithBiometrics(
                    `Pay ${formatCents(r.amountCents)} to ${r.counterparty.displayName}`,
                  )
                )
                  pay.mutate();
              }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Decline"
              variant="secondary"
              loading={decline.isPending}
              onPress={() => decline.mutate()}
            />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

export function RequestsScreen() {
  const requests = useQuery({ queryKey: queryKeys.requests, queryFn: api.requests });
  return (
    <Screen>
      <Button title="New request" onPress={() => router.push('/request-new')} />
      {requests.isLoading ? (
        <Loading />
      ) : requests.isError ? (
        <ErrorState message="Could not load requests." onRetry={() => void requests.refetch()} />
      ) : requests.data!.length === 0 ? (
        <Empty title="No requests" body="Ask someone to pay you back." />
      ) : (
        requests.data!.map((r) => <RequestRow key={r.id} r={r} />)
      )}
    </Screen>
  );
}

export function NewRequestScreen() {
  const t = useTheme();
  const client = useQueryClient();
  const [query, setQuery] = useState('');
  const [to, setTo] = useState<{ accountId: string; displayName: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const cents = parseRandToCents(amount);
  const contacts = useQuery({
    queryKey: ['contacts', query],
    queryFn: () => api.searchContacts(query),
    enabled: !to && query.trim().length >= 2,
  });
  const create = useMutation({
    mutationFn: () =>
      api.createRequest({ toAccountId: to!.accountId, amountCents: cents!, reference }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.requests });
      router.back();
    },
  });
  return (
    <Screen>
      {to ? (
        <Card>
          <Muted>Requesting from</Muted>
          <Title>{to.displayName}</Title>
          <Button title="Change" variant="secondary" onPress={() => setTo(null)} />
        </Card>
      ) : (
        <View style={{ gap: space(2) }}>
          <Field
            label="From"
            placeholder="Name, email or phone"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
          />
          {(contacts.data ?? []).map((c) => (
            <Pressable
              key={c.accountId}
              accessibilityRole="button"
              onPress={() => setTo(c)}
              style={{ paddingVertical: space(3) }}
            >
              <Text style={{ color: t.text, fontWeight: '600' }}>{c.displayName}</Text>
              <Muted>{c.email}</Muted>
            </Pressable>
          ))}
        </View>
      )}
      <Field
        label="Amount (R)"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />
      <Field label="Reference" value={reference} onChangeText={setReference} maxLength={60} />
      {create.error ? (
        <Text style={{ color: t.danger }}>{(create.error as Error).message}</Text>
      ) : null}
      <Button
        title="Send request"
        disabled={!to || !cents}
        loading={create.isPending}
        onPress={() => create.mutate()}
      />
    </Screen>
  );
}
