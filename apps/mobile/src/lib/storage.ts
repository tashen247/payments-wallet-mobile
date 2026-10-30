import * as SecureStore from 'expo-secure-store';

const KEYS = {
  access: 'wallet.accessToken',
  refresh: 'wallet.refreshToken',
  pin: 'wallet.pin',
} as const;

export const secure = {
  async getTokens() {
    const [accessToken, refreshToken] = await Promise.all([
      SecureStore.getItemAsync(KEYS.access),
      SecureStore.getItemAsync(KEYS.refresh),
    ]);
    return accessToken && refreshToken ? { accessToken, refreshToken } : null;
  },
  async setTokens(accessToken: string, refreshToken: string) {
    await Promise.all([
      SecureStore.setItemAsync(KEYS.access, accessToken),
      SecureStore.setItemAsync(KEYS.refresh, refreshToken),
    ]);
  },
  async clear() {
    await Promise.all([
      SecureStore.deleteItemAsync(KEYS.access),
      SecureStore.deleteItemAsync(KEYS.refresh),
    ]);
  },
  getPin: () => SecureStore.getItemAsync(KEYS.pin),
  setPin: (pin: string) => SecureStore.setItemAsync(KEYS.pin, pin),
};
