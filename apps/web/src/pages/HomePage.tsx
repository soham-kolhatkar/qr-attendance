import { Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCheck, IconChevronRight } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { api, unwrap } from '../api/client';
import { useMe } from '../auth/AuthContext';
import { PageHeader, QueryState } from '../components/common';
import { Percent } from '../components/report';

export function HomePage() {
  const me = useMe();
  switch (me.user.role) {
    case 'platform_admin':
      return <Navigate to="/platform/institutes" replace />;
    case 'student':
      return <Navigate to="/profile" replace />;
    case 'faculty':
    case 'hod':
      return <Navigate to="/classes" replace />;
    default:
      return <AdminHome />;
  }
}

/** Counts that drive the setup checklist and the summary tiles. */
function useOverview() {
  return useQuery({
    queryKey: ['overview'],
    queryFn: async () => {
      const count = async (role: 'faculty' | 'hod') =>
        unwrap(await api.GET('/v1/users/', { params: { query: { role, pageSize: 1 } } })).total;
      const [structure, students, faculty, hods, terms, subjects, offerings, sessions, open] = await Promise.all([
        api.GET('/v1/structure/').then(unwrap),
        api.GET('/v1/students/', { params: { query: { pageSize: 1 } } }).then(unwrap),
        count('faculty'),
        count('hod'),
        api.GET('/v1/terms/').then(unwrap),
        api.GET('/v1/subjects/', { params: { query: {} } }).then(unwrap),
        api.GET('/v1/offerings/', { params: { query: { pageSize: 1 } } }).then(unwrap),
        api.GET('/v1/sessions/', { params: { query: { pageSize: 1 } } }).then(unwrap),
        api.GET('/v1/sessions/', { params: { query: { pageSize: 1, status: 'open' } } }).then(unwrap),
      ]);
      // A "class" is a unit nothing else hangs under (e.g. a division), not a department or year.
      const parents = new Set(structure.units.map((u) => u.parentId));
      return {
        levels: structure.levels.length,
        units: structure.units.filter((u) => !parents.has(u.id)).length,
        students: students.total,
        staff: faculty + hods,
        terms: terms.length,
        subjects: subjects.length,
        offerings: offerings.total,
        sessions: sessions.total,
        openSessions: open.total,
      };
    },
  });
}

function AdminHome() {
  const me = useMe();
  const overview = useOverview();
  const o = overview.data;

  const steps = o
    ? [
        { done: o.levels > 0, title: 'Describe your structure', text: 'Name your levels, e.g. Department › Year › Division.', to: '/structure', action: 'Set up structure' },
        { done: o.staff > 0, title: 'Add teachers and HODs', text: 'Import them from Excel or add them one by one.', to: '/import', action: 'Import staff' },
        { done: o.students > 0, title: 'Add students', text: 'Import from Excel; missing classes and batches are created for you.', to: '/import', action: 'Import students' },
        { done: o.terms > 0 && o.subjects > 0, title: 'Add a term and subjects', text: 'e.g. "2026-27 Odd Semester" and subject codes.', to: '/catalog', action: 'Terms & subjects' },
        { done: o.offerings > 0, title: 'Assign classes to teachers', text: 'Who teaches which subject to which class or batch.', to: '/offerings', action: 'Create offerings' },
        { done: o.sessions > 0, title: 'Take attendance', text: 'Teachers start a session from "My classes" and project the QR code.', to: '/classes', action: 'Open My classes' },
      ]
    : [];
  const done = steps.filter((s) => s.done).length;

  return (
    <>
      <PageHeader title={`Welcome, ${me.user.fullName}`} description={me.institute?.name} />
      <QueryState query={overview}>
        {o && (
          <Stack gap="lg">
            <SimpleGrid cols={{ base: 2, md: 4 }}>
              <Stat label="Students" value={o.students} />
              <Stat label="Teachers & HODs" value={o.staff} />
              <Stat label="Classes" value={o.units} />
              <Stat label="Sessions running now" value={o.openSessions} highlight={o.openSessions > 0} />
            </SimpleGrid>

            <TermAttendance />

            {done < steps.length && (
              <Card withBorder padding="lg">
                <Group justify="space-between" mb="xs">
                  <Text fw={600}>Getting started</Text>
                  <Text size="sm" c="dimmed">
                    {done} of {steps.length} done
                  </Text>
                </Group>
                <Progress value={(done / steps.length) * 100} mb="md" />
                <Stack gap="sm">
                  {steps.map((s, i) => (
                    <Group key={s.title} justify="space-between" wrap="nowrap" align="center">
                      <Group wrap="nowrap" align="flex-start">
                        <ThemeIcon radius="xl" size="md" variant={s.done ? 'filled' : 'light'} color={s.done ? 'teal' : 'gray'}>
                          {s.done ? <IconCheck size={14} /> : <Text size="xs">{i + 1}</Text>}
                        </ThemeIcon>
                        <div>
                          <Text fw={500} td={s.done ? 'line-through' : undefined} c={s.done ? 'dimmed' : undefined}>
                            {s.title}
                          </Text>
                          <Text size="sm" c="dimmed">
                            {s.text}
                          </Text>
                        </div>
                      </Group>
                      {!s.done && (
                        <Button component={Link} to={s.to} size="xs" variant="light" rightSection={<IconChevronRight size={14} />}>
                          {s.action}
                        </Button>
                      )}
                    </Group>
                  ))}
                </Stack>
              </Card>
            )}
          </Stack>
        )}
      </QueryState>
    </>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <Card withBorder padding="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Group gap="xs" align="baseline">
        <Text fz={30} fw={700}>
          {value.toLocaleString()}
        </Text>
        {highlight && (
          <Badge color="teal" variant="dot">
            live
          </Badge>
        )}
      </Group>
    </Card>
  );
}

/** This term at a glance, linking to the full reports. */
function TermAttendance() {
  const summary = useQuery({
    queryKey: ['reports', 'summary', {}],
    queryFn: async () => unwrap(await api.GET('/v1/reports/summary', { params: { query: {} } })),
  });
  const s = summary.data;
  if (!s?.term || s.sessions === 0) return null;
  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" wrap="wrap">
        <Group gap="xl" wrap="wrap">
          <div>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Attendance · {s.term.name}
            </Text>
            <Percent value={s.overall.percentage} minimum={s.minimumPercent} fz={30} fw={700} />
          </div>
          <div>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              Below {s.minimumPercent}%
            </Text>
            <Text fz={30} fw={700} c={s.students.below > 0 ? 'red' : undefined}>
              {s.students.below.toLocaleString()}
              <Text span size="sm" c="dimmed" fw={400}>
                {' '}
                of {s.students.total.toLocaleString()} students
              </Text>
            </Text>
          </div>
        </Group>
        <Button component={Link} to="/reports" variant="light" rightSection={<IconChevronRight size={14} />}>
          Open reports
        </Button>
      </Group>
    </Card>
  );
}
