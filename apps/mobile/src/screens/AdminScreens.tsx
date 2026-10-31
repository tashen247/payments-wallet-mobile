import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatCents } from '@wallet/shared';
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
import { api } from '../lib/api';
import { space, useTheme } from '../theme';

const STATUSES = ['all', 'completed', 'failed'] as const;

export function AdminTransfersScreen() {
  const t = useTheme();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const list = useQuery({
    queryKey: ['admin', 'transfers', status],
    queryFn: () => api.admin.transfers(status === 'all' ? undefined : status),
  });
  return (
    <Screen>
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        {STATUSES.map((s) => (
          <Pressable
            key={s}
            accessibilityRole="tab"
            accessibilityState={{ selected: s === status }}
            onPress={() => setStatus(s)}
            style={{
              paddingHorizontal: space(3),
              paddingVertical: space(2),
              borderRadius: 999,
              backgroundColor: s === status ? t.primary : t.card,
            }}
          >
            <Text
              style={{
                color: s === status ? t.primaryText : t.text,
                fontWeight: '600',
                textTransform: 'capitalize',
              }}
            >
              {s}
            </Text>
          </Pressable>
        ))}
      </View>
      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState message="Could not load transfers." />
      ) : list.data!.length === 0 ? (
        <Empty title="Nothing here" />
      ) : (
        list.data!.map((x) => (
          <Card key={x.id}>
            <Text
              style={{ color: t.text, fontWeight: '700' }}
            >{`${formatCents(x.amountCents)} · ${x.type}`}</Text>
            <Muted>{`${x.fromName} → ${x.toName}`}</Muted>
            <Text style={{ color: x.status === 'failed' ? t.danger : t.success }}>
              {x.status}
              {x.failureCode ? ` · ${x.failureCode}` : ''}
            </Text>
          </Card>
        ))
      )}
    </Screen>
  );
}

export function AdminDeadLettersScreen() {
  const t = useTheme();
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ['admin', 'dead-letters'],
    queryFn: api.admin.deadLetters,
    refetchInterval: 5000,
  });
  const replay = useMutation({
    mutationFn: api.admin.replay,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin', 'dead-letters'] }),
  });
  return (
    <Screen>
      <Title>Dead letters</Title>
      <Muted>
        Events the worker gave up on after its retries. Replay is safe to press twice: side effects
        that already happened are skipped.
      </Muted>
      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState message="Could not load dead letters." />
      ) : list.data!.length === 0 ? (
        <Empty title="No dead letters" body="Every event was delivered." />
      ) : (
        list.data!.map((d) => (
          <Card key={d.id}>
            <Text style={{ color: t.text, fontWeight: '700' }}>{d.type}</Text>
            <Muted>{`${d.attempts} attempts · ${new Date(d.createdAt).toLocaleString('en-ZA')}`}</Muted>
            <Text style={{ color: t.danger }}>{d.lastError}</Text>
            <Button
              title="Replay"
              loading={replay.isPending && replay.variables === d.id}
              onPress={() => replay.mutate(d.id)}
            />
          </Card>
        ))
      )}
    </Screen>
  );
}

export function AdminAccountsScreen() {
  const t = useTheme();
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['admin', 'accounts', q],
    queryFn: () => api.admin.accounts(q.trim() || undefined),
  });
  const toggle = useMutation({
    mutationFn: ({ accountId, frozen }: { accountId: string; frozen: boolean }) =>
      api.admin.setFrozen(accountId, frozen),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['admin', 'accounts'] }),
  });
  return (
    <Screen>
      <Field label="Search accounts" value={q} onChangeText={setQ} autoCapitalize="none" />
      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <ErrorState message="Could not load accounts." />
      ) : (
        list.data!.map((a) => (
          <Card key={a.accountId}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: t.text, fontWeight: '700' }}>{a.displayName}</Text>
                <Muted>{a.email}</Muted>
                <Text style={{ color: t.text }}>{formatCents(a.balanceCents)}</Text>
              </View>
              {a.frozen ? (
                <Text accessibilityLabel="Frozen" style={{ color: t.danger, fontWeight: '700' }}>
                  FROZEN
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${a.frozen ? 'Unfreeze' : 'Freeze'} ${a.displayName}`}
                disabled={toggle.isPending}
                onPress={() => toggle.mutate({ accountId: a.accountId, frozen: !a.frozen })}
                style={({ pressed }) => ({
                  paddingHorizontal: space(3),
                  paddingVertical: space(2),
                  borderRadius: 10,
                  borderWidth: 1.5,
                  borderColor: a.frozen ? t.primary : t.danger,
                  opacity:
                    pressed || (toggle.isPending && toggle.variables?.accountId === a.accountId)
                      ? 0.6
                      : 1,
                })}
              >
                <Text style={{ color: a.frozen ? t.primary : t.danger, fontWeight: '700' }}>
                  {a.frozen ? 'Unfreeze' : 'Freeze'}
                </Text>
              </Pressable>
            </View>
          </Card>
        ))
      )}
    </Screen>
  );
}
