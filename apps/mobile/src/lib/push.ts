import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { api } from './api';
import { useSession } from './session';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Push needs a physical device and an EAS project id (see README). Returns null otherwise. */
export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('payments', {
      name: 'Payments',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)
    ?.projectId;
  if (!projectId) {
    console.warn('EAS_PROJECT_ID is not set; push notifications are disabled');
    return null;
  }
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api.registerDevice(token, Platform.OS === 'ios' ? 'ios' : 'android');
  return token;
}

export function usePushNotifications() {
  const signedIn = useSession((s) => s.status === 'signedIn' && s.unlocked);
  useEffect(() => {
    if (!signedIn) return;
    registerForPush().catch((err) => console.warn('push registration failed', err));
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as {
        transactionId?: string;
        paymentRequestId?: string;
      };
      if (data.transactionId)
        router.push({ pathname: '/transaction/[id]', params: { id: data.transactionId } });
      else if (data.paymentRequestId) router.push('/requests');
    });
    return () => sub.remove();
  }, [signedIn]);
}
