import { ActionIcon, Badge, Box, Button, Card, Collapse, Grid, Group, Menu, Stack, Text, TextInput } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconChevronRight, IconDots, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { api, unwrap } from '../../api/client';
import { useStructure } from '../../api/hooks';
import { useApiMutation } from '../../api/mutations';
import type { Level, Unit } from '../../api/types';
import { confirmDelete, EmptyHint, PageHeader, QueryState } from '../../components/common';
import { openFormModal } from '../../components/FormModal';

const REFRESH = [['structure'], ['overview']];

export function StructurePage() {
  const structure = useStructure();
  return (
    <>
      <PageHeader
        title="Structure"
        description="How your institute is organised. Name the levels first (e.g. Department › Year › Division), then add the units at each level. Students belong to a unit; lab batches and electives are set up under Batches & groups."
      />
      <QueryState query={structure}>
        <Grid gap="lg">
          <Grid.Col span={{ base: 12, md: 4 }}>
            <LevelsCard levels={structure.levels} hasUnitsAt={(depth) => structure.options.some((o) => o.depth === depth)} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 8 }}>
            <UnitsCard />
          </Grid.Col>
        </Grid>
      </QueryState>
    </>
  );
}

function LevelsCard({ levels, hasUnitsAt }: { levels: Level[]; hasUnitsAt: (depth: number) => boolean }) {
  const [name, setName] = useState('');
  const add = useApiMutation(async (n: string) => unwrap(await api.POST('/v1/structure/levels', { body: { name: n } })), {
    invalidate: REFRESH,
  });
  const rename = useApiMutation(
    async (v: { id: string; name: string }) =>
      unwrap(await api.PATCH('/v1/structure/levels/{id}', { params: { path: { id: v.id } }, body: { name: v.name } })),
    { invalidate: REFRESH, success: 'Level renamed' },
  );
  const remove = useApiMutation(
    async (id: string) => unwrap(await api.DELETE('/v1/structure/levels/{id}', { params: { path: { id } } })),
    { invalidate: REFRESH, success: 'Level removed' },
  );

  return (
    <Card withBorder padding="lg">
      <Text fw={600} mb={4}>
        Levels
      </Text>
      <Text size="sm" c="dimmed" mb="md">
        From the top down. These names also become the column headings in import files.
      </Text>
      <Stack gap="xs">
        {levels.map((level, i) => (
          <Group key={level.id} justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap">
              <Badge variant="light" circle>
                {i + 1}
              </Badge>
              <Text>{level.name}</Text>
            </Group>
            <Group gap={4} wrap="nowrap">
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={`Rename ${level.name}`}
                onClick={() =>
                  openFormModal({
                    title: 'Rename level',
                    fields: [{ name: 'name', label: 'Name', initial: level.name }],
                    onSubmit: (v) => rename.mutateAsync({ id: level.id, name: v.name! }),
                  })
                }
              >
                <IconPencil size={16} />
              </ActionIcon>
              {i === levels.length - 1 && !hasUnitsAt(level.depth) && (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={`Remove ${level.name}`}
                  onClick={() => confirmDelete(`level "${level.name}"`, () => remove.mutate(level.id))}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              )}
            </Group>
          </Group>
        ))}
        {levels.length === 0 && <EmptyHint>No levels yet. Add the top level first, e.g. "Department".</EmptyHint>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add.mutate(name.trim(), { onSuccess: () => setName('') });
          }}
        >
          <Group gap="xs" mt="xs" wrap="nowrap">
            <TextInput
              flex={1}
              placeholder={levels.length === 0 ? 'e.g. Department' : 'Next level, e.g. Year'}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              aria-label="New level name"
            />
            <Button type="submit" loading={add.isPending} leftSection={<IconPlus size={16} />}>
              Add
            </Button>
          </Group>
        </form>
      </Stack>
    </Card>
  );
}

function UnitsCard() {
  const structure = useStructure();
  const create = useApiMutation(
    async (v: { parentId?: string; name: string; code?: string }) =>
      unwrap(await api.POST('/v1/structure/units', { body: { parentId: v.parentId, name: v.name, code: v.code || undefined } })),
    { invalidate: REFRESH, success: (u) => `Added ${u.name}` },
  );
  const topLevel = structure.levels[0];
  const roots = structure.children.get(null) ?? [];

  const addUnit = (parent?: Unit) => {
    const level = structure.levels[parent ? parent.depth + 1 : 0]!;
    openFormModal({
      title: parent ? `Add ${level.name} under ${parent.name}` : `Add ${level.name}`,
      fields: [
        { name: 'name', label: `${level.name} name`, placeholder: level.depth === 0 ? 'e.g. Computer Engineering' : undefined },
        { name: 'code', label: 'Short code (optional)', required: false, placeholder: 'e.g. COMP' },
      ],
      submitLabel: 'Add',
      onSubmit: (v) => create.mutateAsync({ parentId: parent?.id, name: v.name!, code: v.code }),
    });
  };

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="md">
        <div>
          <Text fw={600}>Units</Text>
          <Text size="sm" c="dimmed">
            Numbers show how many students are in each unit and everything under it.
          </Text>
        </div>
        {topLevel && (
          <Button variant="light" leftSection={<IconPlus size={16} />} onClick={() => addUnit()}>
            Add {topLevel.name}
          </Button>
        )}
      </Group>
      {!topLevel ? (
        <EmptyHint>Add at least one level first.</EmptyHint>
      ) : roots.length === 0 ? (
        <EmptyHint>No units yet. Add your first {topLevel.name.toLowerCase()}, or import students and they are created for you.</EmptyHint>
      ) : (
        <Stack gap={2}>
          {roots.map((u) => (
            <UnitNode key={u.id} unit={u} onAdd={addUnit} />
          ))}
        </Stack>
      )}
    </Card>
  );
}

function UnitNode({ unit, onAdd }: { unit: Unit; onAdd: (parent: Unit) => void }) {
  const structure = useStructure();
  // Small trees open fully; big ones show the top two levels.
  const [open, { toggle }] = useDisclosure(unit.depth < 2 || structure.byId.size <= 50);
  const children = structure.children.get(unit.id) ?? [];
  const level = structure.levels[unit.depth];
  const nextLevel = structure.levels[unit.depth + 1];

  const update = useApiMutation(
    async (v: { name: string; code: string }) =>
      unwrap(
        await api.PATCH('/v1/structure/units/{id}', {
          params: { path: { id: unit.id } },
          body: { name: v.name, code: v.code || null },
        }),
      ),
    { invalidate: REFRESH, success: 'Saved' },
  );
  const remove = useApiMutation(
    async () => unwrap(await api.DELETE('/v1/structure/units/{id}', { params: { path: { id: unit.id } } })),
    { invalidate: REFRESH, success: `Deleted ${unit.name}` },
  );

  return (
    <div>
      <Group
        justify="space-between"
        wrap="nowrap"
        py={6}
        px="xs"
        style={{ paddingLeft: unit.depth * 24 + 4, borderRadius: 8 }}
        bg={unit.depth === 0 ? 'var(--mantine-color-default-hover)' : undefined}
      >
        <Group gap={6} wrap="nowrap">
          {children.length > 0 ? (
            <ActionIcon variant="subtle" color="gray" size="sm" onClick={toggle} aria-label={open ? 'Collapse' : 'Expand'}>
              {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
            </ActionIcon>
          ) : (
            <Box w={22} />
          )}
          <Text fw={unit.depth === 0 ? 600 : 400}>{unit.name}</Text>
          {unit.code && (
            <Badge size="xs" variant="outline" color="gray">
              {unit.code}
            </Badge>
          )}
          <Text size="xs" c="dimmed">
            {level?.name}
          </Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Badge variant="light" color={unit.totalStudentCount > 0 ? 'indigo' : 'gray'}>
            {unit.totalStudentCount} students
          </Badge>
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${unit.name}`}>
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {nextLevel && (
                <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => onAdd(unit)}>
                  Add {nextLevel.name}
                </Menu.Item>
              )}
              <Menu.Item
                leftSection={<IconPencil size={14} />}
                onClick={() =>
                  openFormModal({
                    title: `Edit ${unit.name}`,
                    fields: [
                      { name: 'name', label: 'Name', initial: unit.name },
                      { name: 'code', label: 'Short code', initial: unit.code ?? '', required: false },
                    ],
                    onSubmit: (v) => update.mutateAsync({ name: v.name!, code: v.code! }),
                  })
                }
              >
                Rename
              </Menu.Item>
              <Menu.Item
                leftSection={<IconTrash size={14} />}
                color="red"
                onClick={() => confirmDelete(`"${unit.name}"`, () => remove.mutate())}
              >
                Delete
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      {children.length > 0 && (
        <Collapse expanded={open}>
          {children.map((c) => (
            <UnitNode key={c.id} unit={c} onAdd={onAdd} />
          ))}
        </Collapse>
      )}
    </div>
  );
}
