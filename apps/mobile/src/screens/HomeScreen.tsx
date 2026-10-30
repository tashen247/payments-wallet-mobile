import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { formatCents } from '@wallet/shared';
import { TransactionRow } from '../components/TransactionRow';
import { Card, Empty, ErrorState, Loading, Muted } from '../components/ui';
import { api } from '../lib/api';
import { queryKeys } from '../lib/live';
import { useSession } from '../lib/session';
import { space, useTheme } from '../theme';

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        paddingVertical: space(3),
        borderRadius: 14,
        backgroundColor: pressed ? t.primary : 'rgba(255,255,255,0.12)',
      })}
    >
      <Text style={{ color: t.heroText, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

export function HomeScreen() {
  const t = useTheme();
  const user = useSession((s) => s.user);
  const wallet = useQuery({ queryKey: queryKeys.wallet, queryFn: api.wallet });
  const recent = useQuery({
    queryKey: [...queryKeys.history, 'recent'],
    queryFn: () => api.history({ limit: 5 }),
  });

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: space(4), gap: space(4) }}
      refreshControl={
        <RefreshControl
          refreshing={wallet.isRefetching}
          onRefresh={() => {
            void wallet.refetch();
            void recent.refetch();
          }}
        />
      }
    >
      <View style={{ backgroundColor: t.hero, borderRadius: 24, padding: space(5), gap: space(4) }}>
        <Text style={{ color: t.heroText, opacity: 0.8 }}>
          {user ? `Hi ${user.displayName.split(' ')[0]}` : 'Your balance'}
        </Text>
        {wallet.isLoading ? (
          <Loading label="Loading balance" />
        ) : wallet.isError ? (
          <Text style={{ color: t.heroText }}>Balance unavailable</Text>
        ) : (
          <View>
            <Text
              accessibilityLabel={`Balance ${formatCents(wallet.data!.balanceCents)}`}
              accessibilityLiveRegion="polite"
              style={{ color: t.heroText, fontSize: 40, fontWeight: '800' }}
            >
              {formatCents(wallet.data!.balanceCents)}
            </Text>
            {wallet.data!.frozen ? (
              <Text style={{ color: t.accent, fontWeight: '700' }}>
                Account frozen. Contact support.
              </Text>
            ) : null}
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <Action label="Send" onPress={() => router.push('/send')} />
          <Action label="Request" onPress={() => router.push('/request-new')} />
          <Action label="Top up" onPress={() => router.push('/topup')} />
        </View>
      </View>

      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>Recent</Text>
          <Pressable accessibilityRole="link" onPress={() => router.push('/history')}>
            <Text style={{ color: t.primary, fontWeight: '600' }}>See all</Text>
          </Pressable>
        </View>
        {recent.isLoading ? (
          <Loading />
        ) : recent.isError ? (
          <ErrorState
            message="Could not load transactions."
            onRetry={() => void recent.refetch()}
          />
        ) : recent.data!.items.length === 0 ? (
          <Empty title="No transactions yet" body="Top up with the test card to get started." />
        ) : (
          recent.data!.items.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              onPress={() => router.push({ pathname: '/transaction/[id]', params: { id: tx.id } })}
            />
          ))
        )}
      </Card>
      <Muted>{`Daily send limit ${wallet.data ? formatCents(wallet.data.dailyLimitCents) : 'R5 000.00'}`}</Muted>
    </ScrollView>
  );
}
