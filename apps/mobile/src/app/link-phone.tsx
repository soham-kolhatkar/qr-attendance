import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { errorMessage } from '@/api/client';
import { useAuth, useMe } from '@/auth/AuthContext';
import { formatDate } from '@/lib/format';
import { linkThisPhone, phoneModel, phoneQueryKey, usePhoneState } from '@/phone/phone';
import { Banner, Button, Card, Icon, Screen, Text } from '@/ui/components';
import { radius, space, useColors } from '@/ui/theme';

/** Links this phone to the student, or shows that a switch is waiting for approval. */
export default function LinkPhoneScreen() {
  const me = useMe();
  const { signOut } = useAuth();
  const colors = useColors();
  const queryClient = useQueryClient();
  const phone = usePhoneState(me.user.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = phone.data;

  const refresh = () => queryClient.invalidateQueries({ queryKey: phoneQueryKey(me.user.id) });

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      await linkThisPhone(me.user.id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const header = (icon: 'cellphone-key' | 'timer-sand' | 'cellphone-off', tint: string, tintBg: string) => (
    <View style={{ alignItems: 'center', marginTop: space.xl }}>
      <View style={{ backgroundColor: tintBg, borderRadius: radius.pill, padding: space.lg }}>
        <Icon name={icon} size={48} color={tint} />
      </View>
    </View>
  );

  if (state?.kind === 'unsupported') {
    return (
      <Screen>
        {header('cellphone-off', colors.warning, colors.warningSoft)}
        <Text variant="title" align="center">
          Not available on this phone yet
        </Text>
        <Text dim align="center">
          This version of the app works on Android phones. Ask your teacher to mark your attendance for now.
        </Text>
        <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
      </Screen>
    );
  }

  if (state?.kind === 'pending') {
    return (
      <Screen refreshControl={<RefreshControl refreshing={phone.isFetching} onRefresh={refresh} />}>
        {header('timer-sand', colors.warning, colors.warningSoft)}
        <Text variant="title" align="center">
          Waiting for approval
        </Text>
        <Text dim align="center">
          You asked to use this phone for attendance on {formatDate(state.device.createdAt)}. Your admin or HOD needs to
          approve the switch.
        </Text>
        <Card>
          {state.active ? (
            <Text>
              Until then, keep scanning with your <Text style={{ fontWeight: '600' }}>{state.active.model ?? 'old phone'}</Text>, or ask
              your teacher to mark you.
            </Text>
          ) : (
            <Text>Until then, ask your teacher to mark your attendance.</Text>
          )}
        </Card>
        <Button title="Check again" icon="refresh" onPress={refresh} loading={phone.isFetching} />
        <Button title="Sign out" variant="ghost" onPress={() => void signOut()} />
      </Screen>
    );
  }

  const other = state?.kind === 'unlinked' ? state.active : null;
  return (
    <Screen>
      {header('cellphone-key', colors.primary, colors.infoSoft)}
      <Text variant="title" align="center">
        {other ? 'Switch to this phone?' : 'Link this phone'}
      </Text>
      <Text dim align="center">
        Your attendance can only be marked from one phone — yours. This phone ({phoneModel() ?? 'this phone'}) will be
        linked to {me.user.fullName}.
      </Text>

      {other ? (
        <Banner tone="warning" title={`Your account is linked to ${other.model ?? 'another phone'}`}>
          {`Linking this phone sends a request to your admin or HOD. Your ${other.model ?? 'old phone'} keeps working until they approve it.`}
        </Banner>
      ) : (
        <Card>
          <Row icon="shield-key-outline" text="A security key is created inside this phone's hardware. It can't be copied to another phone." />
          <Row icon="account-lock-outline" text="Nobody else can use this phone for their attendance, and you can't use another phone." />
          <Row icon="swap-horizontal" text="Got a new phone? Link it the same way; your admin approves the switch." />
        </Card>
      )}

      {error && <Banner tone="danger">{error}</Banner>}
      <Button title={other ? 'Ask to switch to this phone' : 'Link this phone'} icon="link-variant" onPress={link} loading={busy} />
      <Button title="Sign out" variant="ghost" onPress={() => void signOut()} />
    </Screen>
  );
}

function Row({ icon, text }: { icon: 'shield-key-outline' | 'account-lock-outline' | 'swap-horizontal'; text: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
      <Icon name={icon} size={22} color={colors.primary} />
      <Text style={{ flex: 1 }}>{text}</Text>
    </View>
  );
}
