const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export const formatDateTime = (iso: string | null | undefined) => (iso ? dateTime.format(new Date(iso)) : '—');
export const formatTime = (iso: string | null | undefined) => (iso ? time.format(new Date(iso)) : '—');
export const formatDate = (isoDate: string | null | undefined) => (isoDate ? date.format(new Date(isoDate)) : '—');

/** "4:05" style countdown from milliseconds. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export const ROLE_LABELS: Record<string, string> = {
  platform_admin: 'Platform owner',
  admin: 'Admin',
  hod: 'HOD',
  faculty: 'Faculty',
  student: 'Student',
};

export const STATUS_COLORS: Record<string, string> = { present: 'teal', absent: 'red', excused: 'yellow' };

export const percent = (part: number, total: number) => (total === 0 ? 0 : Math.round((part / total) * 100));

export const KIND_LABELS: Record<string, string> = { lecture: 'Lecture', lab: 'Lab', tutorial: 'Tutorial', other: 'Other' };
