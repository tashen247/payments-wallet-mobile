import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { TransactionRow } from '../components/TransactionRow';
import { Empty, ErrorState, Field, Loading } from '../components/ui';
import { api } from '../lib/api';
import { queryKeys } from '../lib/live';
import { space, useTheme } from '../theme';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent' },
  { key: 'received', label: 'Received' },
  { key: 'topup', label: 'Top-ups' },
] as const;

export function HistoryScreen() {
  const t = useTheme();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [q, setQ] = useState('');
  const search = q.trim();

  const history = useInfiniteQuery({
    queryKey: [...queryKeys.history, filter, search],
    queryFn: ({ pageParam }) => api.history({ filter, q: search || undefined, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = history.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, padding: space(4), gap: space(3) }}>
      <Field
        label="Search by reference"
        placeholder="e.g. Rent"
        value={q}
        onChangeText={setQ}
        autoCapitalize="none"
      />
      <View style={{ flexDirection: 'row', gap: space(2) }} accessibilityRole="tablist">
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === f.key }}
            onPress={() => setFilter(f.key)}
            style={{
              paddingHorizontal: space(3),
              paddingVertical: space(2),
              borderRadius: 999,
              backgroundColor: filter === f.key ? t.primary : t.card,
              borderWidth: 1,
              borderColor: t.border,
            }}
          >
            <Text style={{ color: filter === f.key ? t.primaryText : t.text, fontWeight: '600' }}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {history.isLoading ? (
        <Loading label="Loading history" />
      ) : history.isError ? (
        <ErrorState message="Could not load your history." onRetry={() => void history.refetch()} />
      ) : (
        <FlatList
          testID="history-list"
          data={items}
          keyExtractor={(tx) => tx.id}
          renderItem={({ item }) => (
            <TransactionRow
              tx={item}
              onPress={() =>
                router.push({ pathname: '/transaction/[id]', params: { id: item.id } })
              }
            />
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.border }} />}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
          }}
          ListFooterComponent={
            history.isFetchingNextPage ? <Loading label="Loading more" /> : undefined
          }
          ListEmptyComponent={
            <Empty
              title={search ? 'No matches' : 'No transactions yet'}
              body={search ? 'Try another reference.' : 'Top up or send money to get started.'}
            />
          }
          refreshControl={
            <RefreshControl
              refreshing={history.isRefetching && !history.isFetchingNextPage}
              onRefresh={() => void history.refetch()}
            />
          }
        />
      )}
    </View>
  );
}
