import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, unwrap } from './client';
import type { Unit } from './types';

/** Fetches every page of a paginated list endpoint. */
export async function fetchAllPages<T>(
  load: (page: number) => Promise<{ items: T[]; total: number; pageSize: number }>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const res = await load(page);
    items.push(...res.items);
    if (items.length >= res.total || res.items.length < res.pageSize) return items;
  }
}

export function useMeQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => unwrap(await api.GET('/v1/me')),
    enabled,
    staleTime: 60_000,
  });
}

export type UnitOption = { value: string; label: string; depth: number; path: string[]; pathIds: string[] };

/** The structure plus helpers: unit paths, ancestor ids, and select options in tree order. */
export function useStructure() {
  const query = useQuery({
    queryKey: ['structure'],
    queryFn: async () => unwrap(await api.GET('/v1/structure/')),
    staleTime: 30_000,
  });

  const helpers = useMemo(() => {
    const units = query.data?.units ?? [];
    const byId = new Map(units.map((u) => [u.id, u]));
    const pathIds = (id: string): string[] => {
      const out: string[] = [];
      for (let u: Unit | undefined = byId.get(id); u; u = u.parentId ? byId.get(u.parentId) : undefined) out.unshift(u.id);
      return out;
    };
    const pathNames = (id: string) => pathIds(id).map((x) => byId.get(x)?.name ?? '?');

    const children = new Map<string | null, Unit[]>();
    for (const u of units) children.set(u.parentId, [...(children.get(u.parentId) ?? []), u]);
    const collator = new Intl.Collator(undefined, { numeric: true });
    for (const list of children.values()) list.sort((a, b) => collator.compare(a.name, b.name));

    const options: UnitOption[] = [];
    const walk = (parentId: string | null) => {
      for (const u of children.get(parentId) ?? []) {
        options.push({ value: u.id, label: pathNames(u.id).join(' › '), depth: u.depth, path: pathNames(u.id), pathIds: pathIds(u.id) });
        walk(u.id);
      }
    };
    walk(null);
    return { byId, children, pathIds, pathNames, options };
  }, [query.data]);

  return { ...query, levels: query.data?.levels ?? [], ...helpers };
}

export function useGroups(unitId?: string | null) {
  return useQuery({
    queryKey: ['groups', unitId ?? 'all'],
    queryFn: async () => unwrap(await api.GET('/v1/groups/', { params: { query: unitId ? { unitId } : {} } })),
  });
}

export function useTerms() {
  return useQuery({ queryKey: ['terms'], queryFn: async () => unwrap(await api.GET('/v1/terms/')) });
}

export function useSubjects() {
  return useQuery({ queryKey: ['subjects'], queryFn: async () => unwrap(await api.GET('/v1/subjects/', { params: { query: {} } })) });
}

export function useAttendanceSettings() {
  return useQuery({
    queryKey: ['settings', 'attendance'],
    queryFn: async () => unwrap(await api.GET('/v1/settings/attendance')),
  });
}

/** Everyone who can teach (faculty, HODs, admins), for "who teaches this" pickers. */
export function useTeachers() {
  return useQuery({
    queryKey: ['users', 'directory'],
    queryFn: async () => unwrap(await api.GET('/v1/directory/staff')),
    staleTime: 60_000,
  });
}
