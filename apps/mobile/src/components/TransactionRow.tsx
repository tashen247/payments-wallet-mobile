import { Pressable, Text, View } from 'react-native';
import { formatCents, type TransactionDto } from '@wallet/shared';
import { space, useTheme } from '../theme';

export function describe(tx: TransactionDto): string {
  if (tx.direction === 'topup') return 'Card top-up';
  const name = tx.counterparty?.displayName ?? 'Unknown';
  return tx.direction === 'sent' ? `To ${name}` : `From ${name}`;
}

export function TransactionRow({ tx, onPress }: { tx: TransactionDto; onPress?: () => void }) {
  const t = useTheme();
  const incoming = tx.direction !== 'sent';
  const sign = incoming ? '+' : '−';
  const color = tx.status === 'failed' ? t.muted : incoming ? t.success : t.text;
  const date = new Date(tx.createdAt).toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
  });
  const label = `${describe(tx)}, ${incoming ? 'received' : 'sent'} ${formatCents(tx.amountCents)}, ${tx.status}, ${date}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        paddingVertical: space(3),
        gap: space(3),
        alignItems: 'center',
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.text, fontWeight: '600' }} numberOfLines={1}>
          {describe(tx)}
        </Text>
        <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={1}>
          {[
            tx.direction === 'topup' ? 'Test card' : tx.reference,
            date,
            tx.status !== 'completed' ? tx.status : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      <Text
        style={{
          color,
          fontWeight: '700',
          textDecorationLine: tx.status === 'failed' ? 'line-through' : 'none',
        }}
      >
        {sign}
        {formatCents(tx.amountCents)}
      </Text>
    </Pressable>
  );
}
