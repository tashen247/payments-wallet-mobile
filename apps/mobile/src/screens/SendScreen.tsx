import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  formatCents,
  parseRandToCents,
  type ContactDto,
  type TransactionDto,
} from '@wallet/shared';
import { Button, Card, Field, Muted, Screen, Title } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { confirmWithBiometrics } from '../lib/biometrics';
import { useIdempotencyKey, withRetries } from '../lib/idempotency';
import { queryKeys } from '../lib/live';
import { space, useTheme } from '../theme';

interface Recipient {
  accountId: string;
  displayName: string;
}

type Phase = 'form' | 'pending' | 'completed' | 'failed';

export function SendScreen({
  initialTo,
  initialAmountCents,
  initialRef,
}: {
  initialTo?: string;
  initialAmountCents?: number;
  initialRef?: string;
}) {
  const t = useTheme();
  const client = useQueryClient();
  const idem = useIdempotencyKey();
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [query, setQuery] = useState('');
  const [amount, setAmount] = useState(
    initialAmountCents ? (initialAmountCents / 100).toFixed(2) : '',
  );
  const [reference, setReference] = useState(initialRef ?? '');
  const [phase, setPhase] = useState<Phase>('form');
  const [result, setResult] = useState<TransactionDto | null>(null);
  const [error, setError] = useState<string>();

  // A scanned QR code only carries an account id; resolve the name so the sender can check it.
  const scanned = useQuery({
    queryKey: ['resolve', initialTo],
    queryFn: () => api.resolveAccount(initialTo!),
    enabled: !!initialTo && !recipient,
  });
  const chosen = recipient ?? scanned.data ?? null;

  const wallet = useQuery({ queryKey: queryKeys.wallet, queryFn: api.wallet });
  const contacts = useQuery({
    queryKey: ['contacts', query],
    queryFn: () => api.searchContacts(query),
    enabled: !chosen && query.trim().length >= 2,
  });

  const cents = parseRandToCents(amount);
  const remainingToday = wallet.data
    ? wallet.data.dailyLimitCents - wallet.data.sentTodayCents
    : null;

  const send = useMutation({
    mutationFn: async () => {
      const key = idem.current();
      return withRetries(
        () =>
          api.transfer(
            { toAccountId: chosen!.accountId, amountCents: cents!, reference: reference.trim() },
            key,
          ),
        (err) => err instanceof ApiError && err.retryable,
      );
    },
    onMutate: () => setPhase('pending'),
    onSuccess: (tx) => {
      setResult(tx);
      setPhase('completed');
      idem.reset();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void client.invalidateQueries({ queryKey: queryKeys.wallet });
      void client.invalidateQueries({ queryKey: queryKeys.history });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setPhase('failed');
      // A recorded business failure keeps its key (a retry would return the same answer);
      // a fresh attempt after the user edits the form gets a new one.
      idem.reset();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    },
  });

  const onSend = async () => {
    setError(undefined);
    if (!chosen || !cents) return;
    const ok = await confirmWithBiometrics(`Send ${formatCents(cents)} to ${chosen.displayName}`);
    if (!ok) {
      setError('Payment not confirmed.');
      return;
    }
    send.mutate();
  };

  if (phase === 'pending') {
    return (
      <Screen>
        <Card>
          <Title>Sending…</Title>
          <Muted>{`${formatCents(cents ?? 0)} to ${chosen?.displayName}`}</Muted>
          <Text accessibilityLiveRegion="polite" style={{ color: t.pending, fontWeight: '600' }}>
            Pending
          </Text>
        </Card>
      </Screen>
    );
  }

  if (phase === 'completed' && result) {
    return (
      <Screen>
        <Card>
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: t.success, fontWeight: '700', fontSize: 18 }}
          >
            Payment sent
          </Text>
          <Title>{formatCents(result.amountCents)}</Title>
          <Muted>{`To ${result.counterparty?.displayName ?? ''}${result.reference ? ` · ${result.reference}` : ''}`}</Muted>
        </Card>
        <Button title="Done" onPress={() => router.back()} />
        <Button
          title="View details"
          variant="secondary"
          onPress={() =>
            router.replace({ pathname: '/transaction/[id]', params: { id: result.id } })
          }
        />
      </Screen>
    );
  }

  return (
    <Screen>
      {phase === 'failed' && error ? (
        <Card>
          <Text accessibilityRole="alert" style={{ color: t.danger, fontWeight: '700' }}>
            Payment failed
          </Text>
          <Muted>{error}</Muted>
        </Card>
      ) : null}

      {chosen ? (
        <Card>
          <Muted>Paying</Muted>
          <Title>{chosen.displayName}</Title>
          {!initialTo ? (
            <Button title="Change" variant="secondary" onPress={() => setRecipient(null)} />
          ) : null}
        </Card>
      ) : scanned.isLoading ? (
        <Muted>Checking the QR code…</Muted>
      ) : scanned.isError ? (
        <Text style={{ color: t.danger }}>That QR code is not a valid wallet.</Text>
      ) : (
        <View style={{ gap: space(2) }}>
          <Field
            label="Recipient"
            placeholder="Name, email or phone"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
          />
          <Button title="Scan QR code" variant="secondary" onPress={() => router.push('/scan')} />
          {contacts.data && contacts.data.length > 0 ? (
            <Muted>Tap a name to choose who to pay.</Muted>
          ) : null}
          {(contacts.data ?? []).map((c: ContactDto) => (
            <Pressable
              key={c.accountId}
              accessibilityRole="button"
              accessibilityLabel={`Pay ${c.displayName}`}
              onPress={() => setRecipient({ accountId: c.accountId, displayName: c.displayName })}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                padding: space(3),
                borderRadius: 12,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: pressed ? t.border : t.card,
              })}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '600' }}>{c.displayName}</Text>
                <Muted>{c.email}</Muted>
              </View>
              <Text style={{ color: t.primary, fontWeight: '700' }}>Choose ›</Text>
            </Pressable>
          ))}
          {query.trim().length >= 2 && contacts.data?.length === 0 ? (
            <Muted>No one matches that.</Muted>
          ) : null}
        </View>
      )}

      <Field
        label="Amount (R)"
        placeholder="0.00"
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={setAmount}
        error={amount && !cents ? 'Enter an amount like 250 or 250.50' : undefined}
      />
      <Field
        label="Reference"
        placeholder="What's it for?"
        value={reference}
        onChangeText={setReference}
        maxLength={60}
      />
      {wallet.data ? (
        <Muted>{`Balance ${formatCents(wallet.data.balanceCents)} · ${formatCents(Math.max(0, remainingToday ?? 0))} left to send today`}</Muted>
      ) : null}
      {phase === 'form' && error ? <Text style={{ color: t.danger }}>{error}</Text> : null}
      <Button
        title={!chosen ? 'Choose a recipient first' : cents ? `Send ${formatCents(cents)}` : 'Send'}
        onPress={onSend}
        disabled={!chosen || !cents}
        accessibilityHint="Asks for Face ID, fingerprint or your PIN"
      />
    </Screen>
  );
}
