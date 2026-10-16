import { Button, Group, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { useState } from 'react';

type Field = {
  name: string;
  label: string;
  initial?: string;
  placeholder?: string;
  description?: string;
  required?: boolean;
};

/**
 * A small dialog with text fields. `onSubmit` may throw; the dialog then stays open
 * (the error toast explains why) so the user can correct and retry.
 */
export function openFormModal(options: {
  title: string;
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
}) {
  const id = `form-${Math.random().toString(36).slice(2)}`;
  modals.open({
    modalId: id,
    title: options.title,
    children: <FormBody {...options} close={() => modals.close(id)} />,
  });
}

function FormBody({
  fields,
  submitLabel = 'Save',
  onSubmit,
  close,
}: {
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  close: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const form = useForm({
    initialValues: Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ''])),
    validate: Object.fromEntries(
      fields.filter((f) => f.required !== false).map((f) => [f.name, (v: string) => (v.trim() ? null : 'Required')]),
    ),
  });

  return (
    <form
      onSubmit={form.onSubmit(async (values) => {
        setSaving(true);
        try {
          await onSubmit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).trim()])));
          close();
        } catch {
          // The global error toast has explained what went wrong.
        } finally {
          setSaving(false);
        }
      })}
    >
      <Stack>
        {fields.map((f, i) => (
          <TextInput
            key={f.name}
            label={f.label}
            placeholder={f.placeholder}
            description={f.description}
            data-autofocus={i === 0 || undefined}
            {...form.getInputProps(f.name)}
          />
        ))}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {submitLabel}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
