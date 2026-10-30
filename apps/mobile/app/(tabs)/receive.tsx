import { ReceiveScreen } from '../../src/screens/MoneyScreens';
import { Button } from '../../src/components/ui';
import { useSession } from '../../src/lib/session';
import { View } from 'react-native';

export default function Receive() {
  const signOut = useSession((s) => s.signOut);
  return (
    <View style={{ flex: 1 }}>
      <ReceiveScreen />
      <View style={{ padding: 16 }}>
        <Button title="Log out" variant="secondary" onPress={() => void signOut()} />
      </View>
    </View>
  );
}
