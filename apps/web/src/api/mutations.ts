import { notifications } from '@mantine/notifications';
import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';

/**
 * A save action: on success it refreshes the given queries and shows a short
 * confirmation; on failure the global handler shows the server's message.
 */
export function useApiMutation<TVars, TData>(
  fn: (vars: TVars) => Promise<TData>,
  options: { invalidate?: QueryKey[]; success?: string | ((data: TData) => string) } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data) => {
      await Promise.all((options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (options.success) {
        notifications.show({
          color: 'teal',
          message: typeof options.success === 'function' ? options.success(data) : options.success,
        });
      }
    },
  });
}
