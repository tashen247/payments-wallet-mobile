import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Button, Field, Muted, Screen, Title } from '../components/ui';
import { confirmWithBiometrics } from '../lib/biometrics';
import { useSession } from '../lib/session';
import { secure } from '../lib/storage';
import { useTheme } from '../theme';

/** Shown on app open (and after time in the background): biometric unlock, PIN fallback. */
export function LockScreen() {
  const t = useTheme();
  const setUnlocked = useSession((s) => s.setUnlocked);
  const signOut = useSession((s) => s.signOut);
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    void secure.getPin().then((p) => setHasPin(!!p));
  }, []);

  const unlock = async () => {
    setError(undefined);
    if (await confirmWithBiometrics('Unlock your wallet')) setUnlocked(true);
    else setError('Not unlocked.');
  };

  useEffect(() => {
    if (hasPin) void unlock();
  }, [hasPin]);

  if (hasPin === false) {
    return (
      <Screen fullScreen>
        <Title>Set an app PIN</Title>
        <Muted>Used when Face ID or fingerprint is not available.</Muted>
        <Field
          label="4-digit PIN"
          value={pin}
          onChangeText={setPin}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={4}
        />
        <Field
          label="Repeat PIN"
          value={confirm}
          onChangeText={setConfirm}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={4}
          error={confirm.length === 4 && confirm !== pin ? 'PINs do not match' : undefined}
        />
        <Button
          title="Save PIN"
          disabled={!/^\d{4}$/.test(pin) || pin !== confirm}
          onPress={async () => {
            await secure.setPin(pin);
            setHasPin(true);
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen fullScreen>
      <Title>Wallet locked</Title>
      {error ? <Text style={{ color: t.danger }}>{error}</Text> : null}
      <Button title="Unlock" onPress={unlock} />
      <Button title="Log out" variant="secondary" onPress={() => void signOut()} />
    </Screen>
  );
}
