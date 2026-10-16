import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <Center py={80}>
      <Stack align="center" gap="xs">
        <Title order={2}>Page not found</Title>
        <Text c="dimmed">This page does not exist, or your account cannot open it.</Text>
        <Button component={Link} to="/" variant="light" mt="sm">
          Go home
        </Button>
      </Stack>
    </Center>
  );
}
