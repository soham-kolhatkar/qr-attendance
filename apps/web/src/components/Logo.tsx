import { Group, Text, ThemeIcon } from '@mantine/core';
import { IconQrcode } from '@tabler/icons-react';

export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <Group gap={8} wrap="nowrap">
      <ThemeIcon size={size === 'lg' ? 40 : 30} radius="md" variant="filled">
        <IconQrcode size={size === 'lg' ? 26 : 20} />
      </ThemeIcon>
      <Text fw={700} size={size === 'lg' ? 'xl' : 'md'}>
        QR Attendance
      </Text>
    </Group>
  );
}
