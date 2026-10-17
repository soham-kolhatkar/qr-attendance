import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { errorMessage } from '@/api/client';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { usePhoneState } from '@/phone/phone';
import { Banner, Button, Centered, Loading, Text } from '@/ui/components';
import { space, useColors } from '@/ui/theme';

export default function RootLayout() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );
  const scheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <Gate />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/**
 * Which screens are reachable: sign in → choose a password (new accounts) → link this
 * phone → the app. Screens outside the current step can't be opened.
 */
function Gate() {
  const { state, retry } = useAuth();
  const colors = useColors();
  const me = state.status === 'signedIn' ? state.me : null;
  const mustChangePassword = !!me?.user.mustChangePassword;
  const phone = usePhoneState(me && !mustChangePassword ? me.user.id : null);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'offline') {
    return (
      <Centered>
        <Text variant="heading" align="center">
          You're offline
        </Text>
        <Text dim align="center" style={{ marginVertical: space.lg, maxWidth: 300 }}>
          Can't reach the server. Check your internet connection and try again.
        </Text>
        <Button title="Try again" icon="refresh" onPress={retry} />
      </Centered>
    );
  }
  if (me && !mustChangePassword && phone.isPending) return <Loading message="Checking this phone…" />;
  if (me && !mustChangePassword && phone.isError) {
    return (
      <Centered>
        <Banner tone="danger" title="Couldn't check this phone">
          {errorMessage(phone.error)}
        </Banner>
        <Button title="Try again" icon="refresh" onPress={() => void phone.refetch()} />
      </Centered>
    );
  }

  const signedIn = me !== null;
  const ready = signedIn && !mustChangePassword && phone.data?.kind === 'linked';
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && mustChangePassword}>
        <Stack.Screen name="change-password" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !mustChangePassword && !ready}>
        <Stack.Screen name="link-phone" />
      </Stack.Protected>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="index" />
        <Stack.Screen name="scan" options={{ animation: 'fade', contentStyle: { backgroundColor: '#000' } }} />
        <Stack.Screen name="account" options={{ animation: 'slide_from_right' }} />
      </Stack.Protected>
    </Stack>
  );
}
