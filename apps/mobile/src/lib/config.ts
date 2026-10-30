/**
 * Phones cannot reach `localhost` on your dev machine. Set EXPO_PUBLIC_API_URL to the machine's
 * LAN address, e.g. http://192.168.1.20:3000 (see README, "Running on two phones").
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
export const WS_URL = `${API_URL.replace(/^http/, 'ws')}/v1/ws`;
