import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Pay Wallet',
  slug: 'payments-wallet-mobile',
  scheme: 'paywallet',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: false,
    bundleIdentifier: 'za.co.tashtech.paywallet',
    infoPlist: {
      NSFaceIDUsageDescription: 'Confirm payments and unlock your wallet with Face ID.',
      NSCameraUsageDescription: 'Scan a receive QR code to pay someone.',
    },
  },
  android: {
    package: 'za.co.tashtech.paywallet',
    adaptiveIcon: {
      backgroundColor: '#0B3D2E',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: ['USE_BIOMETRIC', 'USE_FINGERPRINT', 'CAMERA'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-local-authentication',
      { faceIDPermission: 'Confirm payments and unlock your wallet with Face ID.' },
    ],
    ['expo-camera', { cameraPermission: 'Scan a receive QR code to pay someone.' }],
    'expo-notifications',
  ],
  experiments: { typedRoutes: true },
  extra: {
    // Set EAS_PROJECT_ID (from `eas init`) so push tokens can be issued.
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
};

export default config;
