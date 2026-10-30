import { create } from 'zustand';
import type { AuthResponse, UserDto } from '@wallet/shared';
import { secure } from './storage';

interface SessionState {
  status: 'loading' | 'signedOut' | 'signedIn';
  user: UserDto | null;
  accessToken: string | null;
  refreshToken: string | null;
  /** Set after biometric or PIN unlock; cleared when the app is backgrounded for a while. */
  unlocked: boolean;
  signIn: (auth: AuthResponse) => Promise<void>;
  setTokens: (accessToken: string, refreshToken: string) => Promise<void>;
  setUser: (user: UserDto) => void;
  signOut: () => Promise<void>;
  setUnlocked: (unlocked: boolean) => void;
  hydrate: () => Promise<{ accessToken: string; refreshToken: string } | null>;
}

export const useSession = create<SessionState>((set) => ({
  status: 'loading',
  user: null,
  accessToken: null,
  refreshToken: null,
  unlocked: false,
  async signIn(auth) {
    await secure.setTokens(auth.accessToken, auth.refreshToken);
    // A fresh password login counts as unlocking.
    set({
      status: 'signedIn',
      user: auth.user,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      unlocked: true,
    });
  },
  async setTokens(accessToken, refreshToken) {
    await secure.setTokens(accessToken, refreshToken);
    set({ accessToken, refreshToken });
  },
  setUser: (user) => set({ user }),
  async signOut() {
    await secure.clear();
    set({
      status: 'signedOut',
      user: null,
      accessToken: null,
      refreshToken: null,
      unlocked: false,
    });
  },
  setUnlocked: (unlocked) => set({ unlocked }),
  async hydrate() {
    const tokens = await secure.getTokens();
    set(tokens ? { ...tokens, status: 'signedIn' } : { status: 'signedOut' });
    return tokens;
  },
}));
