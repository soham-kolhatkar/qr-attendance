import * as Application from 'expo-application';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { displayHost, server } from '@/api/server';
import { useAuth, useMe } from '@/auth/AuthContext';
import { formatDate } from '@/lib/format';
import { usePhoneState } from '@/phone/phone';
import { Button, Card, Icon, Screen, Text } from '@/ui/components';
import { space, useColors } from '@/ui/theme';

export default function AccountScreen() {
  const me = useMe();
  const { signOut } = useAuth();
  const colors = useColors();
  const phone = usePhoneState(me.user.id);
  const device = phone.data?.kind === 'linked' ? phone.data.device : null;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Icon name="arrow-left" size={26} />
        </Pressable>
        <Text variant="title">Account</Text>
      </View>

      <Card>
        <Info label="Name" value={me.user.fullName} />
        <Info label="Username" value={me.user.username} />
        {me.institute && <Info label="Institute" value={me.institute.name} />}
        {me.student && (
          <>
            <Info label="Class" value={me.student.unitPath.join(' › ')} />
            {me.student.rollNo && <Info label="Roll no." value={me.student.rollNo} />}
            {me.student.groups.length > 0 && <Info label="Batches" value={me.student.groups.map((g) => g.name).join(', ')} />}
          </>
        )}
        <Text variant="caption" dim>
          Details wrong? Ask your institute admin to correct them.
        </Text>
      </Card>

      {device && (
        <Card>
          <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
            <Icon name="cellphone-check" size={28} color={colors.success} />
            <View style={{ flex: 1 }}>
              <Text variant="label">This phone is linked</Text>
              <Text variant="caption" dim>
                {device.model ?? 'This phone'} · since {formatDate(device.activatedAt)}
              </Text>
            </View>
          </View>
          <Text variant="caption" dim>
            Only this phone can mark your attendance. Got a new phone? Sign in there and link it; your admin approves the
            switch. Lost this one? Tell your admin so they can unlink it.
          </Text>
        </Card>
      )}

      <Button title="Sign out" icon="logout" variant="danger" onPress={() => void signOut()} />
      <Text variant="caption" dim align="center">
        Version {Application.nativeApplicationVersion ?? '?'} · {displayHost(server.url)}
      </Text>
    </Screen>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text variant="caption" dim>
        {label}
      </Text>
      <Text>{value}</Text>
    </View>
  );
}
