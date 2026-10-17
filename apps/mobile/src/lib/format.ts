const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export const formatDate = (iso: string | null | undefined) => (iso ? date.format(new Date(iso)) : '—');
export const formatTime = (iso: string | null | undefined) => (iso ? time.format(new Date(iso)) : '—');

/** "Today, 10:05", "Yesterday, 14:30" or "Mon 14 Oct, 09:00". */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : dayMonth.format(d);
  return `${day}, ${time.format(d)}`;
}

export const KIND_LABELS: Record<string, string> = { lecture: 'Lecture', lab: 'Lab', tutorial: 'Tutorial', other: 'Class' };
