import { Alert, Anchor, Button, Center, Paper, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';

export function LoginPage() {
  const { state, login, lastInstituteCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [ownerMode, setOwnerMode] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const form = useForm({
    initialValues: { instituteCode: lastInstituteCode, username: '', password: '' },
    validate: {
      instituteCode: (v) => (ownerMode || v.trim() ? null : 'Enter your institute code'),
      username: (v) => (v.trim() ? null : 'Enter your username'),
      password: (v) => (v ? null : 'Enter your password'),
    },
  });

  if (state.status === 'authenticated') return <Navigate to={from} replace />;

  const submit = form.onSubmit(async (values) => {
    setError(null);
    try {
      const me = await login({
        instituteCode: ownerMode ? undefined : values.instituteCode.trim(),
        username: values.username.trim(),
        password: values.password,
      });
      navigate(me.user.mustChangePassword ? '/change-password' : from, { replace: true });
    } catch (err) {
      setError(err instanceof TypeError ? 'Cannot reach the server. Check your connection.' : (err as Error).message);
    }
  });

  return (
    <Center mih="100vh" p="md" bg="var(--mantine-color-body)">
      <Stack w="100%" maw={400} gap="lg">
        <Center>
          <Logo size="lg" />
        </Center>
        <Paper withBorder shadow="sm" p="xl" radius="lg">
          <form onSubmit={submit}>
            <Stack>
              <Text fw={600} size="lg">
                Sign in
              </Text>
              {error && (
                <Alert color="red" icon={<IconAlertCircle />} py="xs">
                  {error}
                </Alert>
              )}
              {!ownerMode && (
                <TextInput
                  label="Institute code"
                  placeholder="e.g. DEMO"
                  autoCapitalize="characters"
                  {...form.getInputProps('instituteCode')}
                />
              )}
              <TextInput label="Username" placeholder="Enrollment no. or employee ID" autoComplete="username" {...form.getInputProps('username')} />
              <PasswordInput label="Password" autoComplete="current-password" {...form.getInputProps('password')} />
              <Button type="submit" loading={form.submitting} fullWidth mt="xs">
                Sign in
              </Button>
            </Stack>
          </form>
        </Paper>
        <Text size="xs" c="dimmed" ta="center">
          Forgot your password? Ask your institute admin to reset it.
          <br />
          <Anchor size="xs" c="dimmed" onClick={() => setOwnerMode((v) => !v)}>
            {ownerMode ? 'Institute sign-in' : 'Platform owner sign-in'}
          </Anchor>
        </Text>
      </Stack>
    </Center>
  );
}
