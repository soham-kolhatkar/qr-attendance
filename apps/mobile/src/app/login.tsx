import * as SecureStore from 'expo-secure-store';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, type TextInput, View } from 'react-native';
import { errorCode, errorMessage } from '@/api/client';
import { CAN_CHANGE_SERVER, DEFAULT_SERVER, displayHost, normalizeServerUrl, server } from '@/api/server';
import { useAuth } from '@/auth/AuthContext';
import { Banner, Button, Field, Icon, Screen, Text } from '@/ui/components';
import { radius, space, useColors } from '@/ui/theme';

const INSTITUTE_KEY = 'qra.instituteCode';

export default function LoginScreen() {
  const { state, signIn } = useAuth();
  const colors = useColors();
  const [instituteCode, setInstituteCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const usernameRef = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordRef = useRef<ComponentRef<typeof TextInput>>(null);

  // Most students only ever use one institute code.
  useEffect(() => {
    void SecureStore.getItemAsync(INSTITUTE_KEY).then((code) => code && setInstituteCode(code));
  }, []);

  const submit = async () => {
    if (!instituteCode.trim() || !username.trim() || !password) {
      setError('Enter your institute code, username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    // A free server sleeps when idle and takes up to a minute to wake.
    const slowTimer = setTimeout(() => setSlow(true), 5000);
    try {
      await signIn({ instituteCode: instituteCode.trim().toUpperCase(), username: username.trim().toLowerCase(), password });
      await SecureStore.setItemAsync(INSTITUTE_KEY, instituteCode.trim().toUpperCase());
    } catch (err) {
      setError(errorCode(err) === 'INVALID_CREDENTIALS' ? 'Wrong institute code, username or password.' : errorMessage(err));
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      setBusy(false);
    }
  };

  const notice = state.status === 'signedOut' ? state.notice : undefined;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen contentStyle={{ paddingTop: space.xxl * 1.5 }}>
        <View style={{ alignItems: 'center', gap: space.md, marginBottom: space.lg }}>
          <View style={{ backgroundColor: colors.primary, borderRadius: radius.lg, padding: space.md }}>
            <Icon name="qrcode-scan" size={40} color={colors.onPrimary} />
          </View>
          <Text variant="title" align="center">
            QR Attendance
          </Text>
          <Text dim align="center">
            Sign in with the details your institute gave you.
          </Text>
        </View>

        {notice && <Banner tone="info">{notice}</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}

        <Field
          label="Institute code"
          value={instituteCode}
          onChangeText={setInstituteCode}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="next"
          onSubmitEditing={() => usernameRef.current?.focus()}
          placeholder="e.g. DEMO"
        />
        <Field
          ref={usernameRef}
          label="Username"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          placeholder="Your enrollment number"
        />
        <Field
          ref={passwordRef}
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Button title="Sign in" onPress={submit} loading={busy} />
        {slow && (
          <Text variant="caption" dim align="center">
            Waking up the server — this can take up to a minute the first time.
          </Text>
        )}
        {CAN_CHANGE_SERVER && <ServerPicker />}
      </Screen>
    </KeyboardAvoidingView>
  );
}

/** Testing builds only: point the app at another server (e.g. a staging copy). */
function ServerPicker() {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(server.url);
  const [current, setCurrent] = useState(server.url);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <Pressable onPress={() => setEditing(true)} accessibilityRole="button" style={{ alignSelf: 'center', padding: space.sm }}>
        <Text variant="caption" dim align="center">
          Server: {displayHost(current)} · Change
        </Text>
      </Pressable>
    );
  }
  const save = async (url: string) => {
    if (!normalizeServerUrl(url)) return setError('Enter an address like example.onrender.com');
    await server.set(url);
    setCurrent(server.url);
    setValue(server.url);
    setError(null);
    setEditing(false);
  };
  return (
    <View style={{ gap: space.sm }}>
      <Field
        label="Server address"
        value={value}
        onChangeText={setValue}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        error={error}
      />
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button title="Use default" variant="secondary" onPress={() => void save(DEFAULT_SERVER)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Save" onPress={() => void save(value)} />
        </View>
      </View>
    </View>
  );
}
