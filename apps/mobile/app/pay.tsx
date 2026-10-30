import { Redirect, useLocalSearchParams } from 'expo-router';
import { parseReceiveLink, buildReceiveLink } from '@wallet/shared';

/** Deep link target for paywallet://pay?to=... (opened from another app or the camera). */
export default function Pay() {
  const params = useLocalSearchParams<{ to?: string; amount?: string; ref?: string }>();
  const code = params.to
    ? parseReceiveLink(
        buildReceiveLink({
          to: params.to,
          ...(params.amount ? { amountCents: Number(params.amount) } : {}),
          ...(params.ref ? { ref: params.ref } : {}),
        }),
      )
    : null;
  if (!code) return <Redirect href="/" />;
  return (
    <Redirect
      href={{
        pathname: '/send',
        params: {
          to: code.to,
          ...(code.amountCents ? { amount: String(code.amountCents) } : {}),
          ...(code.ref ? { ref: code.ref } : {}),
        },
      }}
    />
  );
}
