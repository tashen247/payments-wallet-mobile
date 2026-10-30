import { useLocalSearchParams } from 'expo-router';
import { SendScreen } from '../src/screens/SendScreen';

export default function Send() {
  const { to, amount, ref } = useLocalSearchParams<{
    to?: string;
    amount?: string;
    ref?: string;
  }>();
  const cents = amount && /^\d+$/.test(amount) ? Number(amount) : undefined;
  return <SendScreen initialTo={to} initialAmountCents={cents} initialRef={ref} />;
}
