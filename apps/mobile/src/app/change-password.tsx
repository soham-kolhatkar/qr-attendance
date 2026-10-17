import { useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { api, errorCode, errorMessage, unwrap } from '@/api/client';
import { useAuth, useMe } from '@/auth/AuthContext';
import { session } from '@/auth/session';
import { Banner, Button, Field, Screen, Text } from '@/ui/components';
import { space } from '@/ui/theme';

/** New accounts come with a temporary password; the student picks their own first. */
export default function ChangePasswordScreen() {
  const me = useMe();
  const { reloadMe, signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (next.length < 8) return setError('Your new password needs at least 8 characters.');
    if (next !== repeat) return setError("The new passwords don't match.");
    if (next === current) return setError('Choose a password different from the temporary one.');
    setBusy(true);
    setError(null);
    try {
      const tokens = unwrap(
        await api().POST('/v1/auth/change-password', { body: { currentPassword: current, newPassword: next } }),
      );
      await session.setTokens(tokens);
      await reloadMe();
    } catch (err) {
      setError(errorCode(err) === 'INVALID_CREDENTIALS' ? 'The temporary password is wrong.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen contentStyle={{ paddingTop: space.xxl }}>
        <Text variant="title">Choose your password</Text>
        <Text dim>
          Hi {me.user.fullName.split(' ')[0]}. You signed in with a temporary password. Choose your own to continue —
          at least 8 characters, and don't share it.
        </Text>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Temporary password" value={current} onChangeText={setCurrent} secureTextEntry />
        <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" />
        <Field
          label="Repeat new password"
          value={repeat}
          onChangeText={setRepeat}
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Button title="Save password" onPress={submit} loading={busy} />
        <Button title="Sign out" variant="ghost" onPress={() => void signOut()} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
