import { Badge, Group, Progress, Text, type TextProps } from '@mantine/core';

/** Green at or above the minimum, orange within 15 points of it, red below that. */
export function percentColor(percentage: number | null, minimum: number): string {
  if (percentage === null) return 'gray';
  if (percentage >= minimum) return 'teal';
  return percentage >= minimum - 15 ? 'orange' : 'red';
}

export const formatPercent = (p: number | null) => (p === null ? '—' : `${p.toFixed(p % 1 === 0 ? 0 : 1)}%`);

export function Percent({ value, minimum, ...props }: { value: number | null; minimum: number } & TextProps) {
  return (
    <Text fw={600} c={value === null ? 'dimmed' : percentColor(value, minimum)} {...props}>
      {formatPercent(value)}
    </Text>
  );
}

/** A percentage with a bar, for tables. */
export function PercentBar({ value, minimum }: { value: number | null; minimum: number }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Progress value={value ?? 0} color={percentColor(value, minimum)} w={80} size="sm" />
      <Percent value={value} minimum={minimum} size="sm" w={48} ta="right" />
    </Group>
  );
}

export const STATUS_LABEL = { present: 'Present', absent: 'Absent', excused: 'Excused' } as const;
export const STATUS_LETTER = { present: 'P', absent: 'A', excused: 'E' } as const;
export const STATUS_COLOR = { present: 'teal', absent: 'red', excused: 'yellow' } as const;

export function StatusBadge({ status }: { status: keyof typeof STATUS_LABEL }) {
  return (
    <Badge size="sm" variant="light" color={STATUS_COLOR[status]}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** "present 18 of 24 classes (2 excused)" */
export function countsText(t: { present: number; total: number; excused: number }) {
  const counted = t.total - t.excused;
  return `${t.present} of ${counted} class${counted === 1 ? '' : 'es'}${t.excused ? ` (${t.excused} excused)` : ''}`;
}
