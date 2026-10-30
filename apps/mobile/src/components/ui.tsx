import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { space, useTheme } from '../theme';

export function Screen({
  children,
  scroll = true,
  fullScreen = false,
}: {
  children: ReactNode;
  scroll?: boolean;
  /** No navigation header above it, so it must clear the status bar itself. */
  fullScreen?: boolean;
}) {
  const t = useTheme();
  const body = <View style={{ padding: space(4), gap: space(4) }}>{children}</View>;
  return (
    <SafeAreaView
      edges={fullScreen ? ['top', 'bottom'] : ['bottom']}
      style={{ flex: 1, backgroundColor: t.bg }}
    >
      {scroll ? (
        <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{body}</View>
      )}
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '700', color: t.text }}>
      {children}
    </Text>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={{ color: t.muted, fontSize: 14 }}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
      {children}
    </View>
  );
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.primary : variant === 'danger' ? t.danger : 'transparent';
  const fg = variant === 'secondary' ? t.primary : t.primaryText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: bg,
          borderColor: t.primary,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        variant === 'secondary' && { borderWidth: 1.5 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontWeight: '600', fontSize: 16 }}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...props
}: TextInputProps & { label: string; error?: string | undefined }) {
  const t = useTheme();
  return (
    <View style={{ gap: space(1) }}>
      <Text style={{ color: t.muted, fontWeight: '500' }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        style={[
          styles.input,
          { color: t.text, borderColor: error ? t.danger : t.border, backgroundColor: t.card },
        ]}
        {...props}
      />
      {error ? (
        <Text style={{ color: t.danger }} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={styles.center} accessibilityLabel={label}>
      <ActivityIndicator color={t.primary} />
    </View>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.center, { gap: space(1) }]}>
      <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{title}</Text>
      {body ? <Text style={{ color: t.muted, textAlign: 'center' }}>{body}</Text> : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTheme();
  return (
    <View style={[styles.center, { gap: space(3) }]} accessibilityRole="alert">
      <Text style={{ color: t.danger, textAlign: 'center' }}>{message}</Text>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space(4),
    gap: space(2),
  },
  button: {
    minHeight: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space(5),
  },
  input: {
    minHeight: 50,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: space(3),
    fontSize: 16,
  },
  center: { alignItems: 'center', justifyContent: 'center', padding: space(8) },
});
