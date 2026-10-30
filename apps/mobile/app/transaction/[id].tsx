import { useLocalSearchParams } from 'expo-router';
import { TransactionDetailScreen } from '../../src/screens/MoneyScreens';

export default function Transaction() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TransactionDetailScreen id={id} />;
}
