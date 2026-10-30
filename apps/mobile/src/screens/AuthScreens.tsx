import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Text } from 'react-native';
import { z } from 'zod';
import { LoginBody, RegisterBody } from '@wallet/shared';
import { Button, Field, Muted, Screen, Title } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useTheme } from '../theme';

export function LoginScreen() {
  const t = useTheme();
  const signIn = useSession((s) => s.signIn);
  const [error, setError] = useState<string>();
  const form = useForm<z.input<typeof LoginBody>>({
    resolver: zodResolver(LoginBody),
    defaultValues: { email: '', password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setError(undefined);
    try {
      await signIn(await api.login(LoginBody.parse(values)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log in.');
    }
  });

  return (
    <Screen fullScreen>
      <Title>Welcome back</Title>
      <Muted>Log in to your wallet.</Muted>
      <Controller
        control={form.control}
        name="email"
        render={({ field, fieldState }) => (
          <Field
            label="Email"
            value={field.value}
            onChangeText={field.onChange}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            error={fieldState.error?.message}
          />
        )}
      />
      <Controller
        control={form.control}
        name="password"
        render={({ field, fieldState }) => (
          <Field
            label="Password"
            value={field.value}
            onChangeText={field.onChange}
            secureTextEntry
            autoComplete="password"
            error={fieldState.error?.message}
          />
        )}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: t.danger }}>
          {error}
        </Text>
      ) : null}
      <Button title="Log in" onPress={submit} loading={form.formState.isSubmitting} />
      <Link href="/register" style={{ color: t.primary, textAlign: 'center', fontWeight: '600' }}>
        New here? Create a wallet
      </Link>
    </Screen>
  );
}

const RegisterForm = RegisterBody.extend({
  phone: z.string().regex(/^(\+27|0)\d{9}$/, 'South African number, e.g. 0821234567'),
});

export function RegisterScreen() {
  const t = useTheme();
  const signIn = useSession((s) => s.signIn);
  const [error, setError] = useState<string>();
  const form = useForm<z.input<typeof RegisterForm>>({
    resolver: zodResolver(RegisterForm),
    defaultValues: { email: '', phone: '', displayName: '', password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setError(undefined);
    try {
      await signIn(await api.register(values));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your wallet.');
    }
  });

  const fields = [
    { name: 'displayName', label: 'Full name', props: { autoComplete: 'name' as const } },
    {
      name: 'email',
      label: 'Email',
      props: { autoCapitalize: 'none' as const, keyboardType: 'email-address' as const },
    },
    {
      name: 'phone',
      label: 'Cellphone',
      props: { keyboardType: 'phone-pad' as const, placeholder: '082 123 4567' },
    },
    { name: 'password', label: 'Password', props: { secureTextEntry: true } },
  ] as const;

  return (
    <Screen fullScreen>
      <Title>Create your wallet</Title>
      {fields.map((f) => (
        <Controller
          key={f.name}
          control={form.control}
          name={f.name}
          render={({ field, fieldState }) => (
            <Field
              label={f.label}
              value={field.value}
              onChangeText={field.onChange}
              error={fieldState.error?.message}
              {...f.props}
            />
          )}
        />
      ))}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: t.danger }}>
          {error}
        </Text>
      ) : null}
      <Button title="Create wallet" onPress={submit} loading={form.formState.isSubmitting} />
    </Screen>
  );
}
