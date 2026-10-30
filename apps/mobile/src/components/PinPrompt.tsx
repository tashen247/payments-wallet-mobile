import { useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { usePinPrompt, verifyPin } from '../lib/biometrics';
import { space, useTheme } from '../theme';
import { Button, Field } from './ui';

/** App PIN fallback for biometric confirmation. Mounted once in the root layout. */
export function PinPrompt() {
  const t = useTheme();
  const { visible, reason, finish } = usePinPrompt();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (await verifyPin(pin)) {
      setPin('');
      setError(undefined);
      finish(true);
    } else setError('That PIN is not right.');
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => finish(false)}>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          padding: space(6),
          backgroundColor: 'rgba(0,0,0,0.5)',
        }}
      >
        <View
          style={{ backgroundColor: t.card, borderRadius: 20, padding: space(5), gap: space(4) }}
        >
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>{reason}</Text>
          <Field
            label="App PIN"
            value={pin}
            onChangeText={setPin}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={4}
            error={error}
            autoFocus
          />
          <Button title="Confirm" onPress={submit} disabled={pin.length !== 4} />
          <Button
            title="Cancel"
            variant="secondary"
            onPress={() => {
              setPin('');
              finish(false);
            }}
          />
        </View>
      </View>
    </Modal>
  );
}
