import { router } from 'expo-router';
import { Button, Muted, Screen, Title } from '../../src/components/ui';

export default function AdminHome() {
  return (
    <Screen>
      <Title>Operations</Title>
      <Muted>Role-gated: the API rejects these calls for wallet holders.</Muted>
      <Button title="Transfers" onPress={() => router.push('/admin/transfers')} />
      <Button title="Dead letters" onPress={() => router.push('/admin/dead-letters')} />
      <Button title="Freeze or unfreeze accounts" onPress={() => router.push('/admin/accounts')} />
    </Screen>
  );
}
