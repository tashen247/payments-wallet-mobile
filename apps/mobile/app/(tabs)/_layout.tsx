import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { useSession } from '../../src/lib/session';
import { useTheme } from '../../src/theme';

const icon =
  (glyph: string) =>
  ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  const t = useTheme();
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.text,
        headerShadowVisible: false,
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Wallet', tabBarIcon: icon('◉') }} />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: icon('≡') }} />
      <Tabs.Screen name="requests" options={{ title: 'Requests', tabBarIcon: icon('⇄') }} />
      <Tabs.Screen name="receive" options={{ title: 'My QR', tabBarIcon: icon('▣') }} />
      <Tabs.Screen
        name="admin"
        options={{ title: 'Admin', tabBarIcon: icon('⚙\uFE0E'), href: isAdmin ? '/admin' : null }}
      />
    </Tabs>
  );
}
