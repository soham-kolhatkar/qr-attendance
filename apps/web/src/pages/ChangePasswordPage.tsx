import { Alert, Button, Center, Paper, PasswordInput, Stack, Text } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage, unwrap } from '../api/client';
import { useAuth, useMe } from '../auth/AuthContext';
import { session } from '../auth/session';
import { Logo } from '../components/Logo';

export function ChangePasswordPage() {
  const me = useMe();
  const { reload, logout } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const forced = me.user.mustChangePassword;

  const form = useForm({
    initialValues: { currentPassword: '', newPassword: '', confirm: '' },
    validate: {
      currentPassword: (v) => (v ? null : 'Enter your current password'),
      newPassword: (v, values) =>
        v.length < 8 ? 'At least 8 characters' : v === values.currentPassword ? 'Choose a different password' : null,
      confirm: (v, values) => (v === values.newPassword ? null : 'Passwords do not match'),
    },
  });

  const submit = form.onSubmit(async ({ currentPassword, newPassword }) => {
    setError(null);
    try {
      const tokens = unwrap(await api.POST('/v1/auth/change-password', { body: { currentPassword, newPassword } }));
      session.setTokens(tokens);
      await reload();
      notifications.show({ color: 'teal', message: 'Password changed' });
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <Center mih="100vh" p="md">
      <Stack w="100%" maw={420} gap="lg">
        <Center>
          <Logo size="lg" />
        </Center>
        <Paper withBorder shadow="sm" p="xl" radius="lg">
          <form onSubmit={submit}>
            <Stack>
              <div>
                <Text fw={600} size="lg">
                  {forced ? 'Choose your password' : 'Change password'}
                </Text>
                {forced && (
                  <Text size="sm" c="dimmed">
                    You signed in with a temporary password. Choose your own to continue.
                  </Text>
                )}
              </div>
              {error && (
                <Alert color="red" icon={<IconAlertCircle />} py="xs">
                  {error}
                </Alert>
              )}
              <PasswordInput
                label={forced ? 'Temporary password' : 'Current password'}
                autoComplete="current-password"
                {...form.getInputProps('currentPassword')}
              />
              <PasswordInput label="New password" autoComplete="new-password" {...form.getInputProps('newPassword')} />
              <PasswordInput label="Repeat new password" autoComplete="new-password" {...form.getInputProps('confirm')} />
              <Button type="submit" loading={form.submitting}>
                Save password
              </Button>
              {forced ? (
                <Button variant="subtle" color="gray" onClick={() => void logout()}>
                  Sign out
                </Button>
              ) : (
                <Button variant="subtle" color="gray" onClick={() => navigate(-1)}>
                  Cancel
                </Button>
              )}
            </Stack>
          </form>
        </Paper>
      </Stack>
    </Center>
  );
}
