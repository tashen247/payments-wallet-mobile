import * as LocalAuthentication from 'expo-local-authentication';
import { create } from 'zustand';
import { secure } from './storage';

/**
 * PIN fallback: when biometrics are unavailable, not enrolled, or the user taps "Use PIN", the
 * PinPrompt modal (mounted in the root layout) asks for the 4-digit app PIN.
 */
interface PinPromptState {
  visible: boolean;
  reason: string;
  resolve: ((ok: boolean) => void) | null;
  ask: (reason: string) => Promise<boolean>;
  finish: (ok: boolean) => void;
}

export const usePinPrompt = create<PinPromptState>((set, get) => ({
  visible: false,
  reason: '',
  resolve: null,
  ask: (reason) => new Promise<boolean>((resolve) => set({ visible: true, reason, resolve })),
  finish: (ok) => {
    get().resolve?.(ok);
    set({ visible: false, resolve: null });
  },
}));

export async function verifyPin(pin: string): Promise<boolean> {
  const stored = await secure.getPin();
  return stored !== null && stored === pin;
}

/** Ask for Face ID / fingerprint, falling back to the app PIN. Resolves true only on success. */
export async function confirmWithBiometrics(reason: string): Promise<boolean> {
  const [hasHardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  if (hasHardware && enrolled) {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: 'Use PIN',
      cancelLabel: 'Cancel',
      disableDeviceFallback: true,
    });
    if (result.success) return true;
    if (result.error !== 'user_fallback' && result.error !== 'lockout') return false;
  }
  return usePinPrompt.getState().ask(reason);
}
