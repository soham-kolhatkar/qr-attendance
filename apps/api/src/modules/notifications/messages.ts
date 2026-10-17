import type { NotificationData } from '../../db/schema.js';
import type { NotificationKind } from './service.js';

/**
 * The words of every notification, in one place. Bodies are plain text: blank lines
 * separate paragraphs and "• " lines are list items (emails turn them into HTML).
 */

export type Message = { kind: NotificationKind; title: string; body: string; data?: NotificationData };

/** One class meeting, as students recognise it. Times are shown in the institute's time zone. */
export type ClassRef = {
  sessionId: string;
  subjectCode: string;
  subjectName: string;
  kind: string;
  startedAt: Date;
  timezone: string;
};

const KINDS: Record<string, string> = { lecture: 'lecture', lab: 'lab', tutorial: 'tutorial' };

/** "Data Structures lecture on Mon 12 Oct at 10:00 am" */
export function classLabel(c: ClassRef): string {
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: c.timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(c.startedAt);
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: c.timezone, hour: 'numeric', minute: '2-digit' }).format(c.startedAt);
  return `${c.subjectName} ${KINDS[c.kind] ?? 'class'} on ${day.replace(',', '')} at ${time}`;
}

export const attendanceChanged = (c: ClassRef, by: string, status: string, reason: string): Message => ({
  kind: 'attendance.changed',
  title: `Attendance changed: ${c.subjectCode}`,
  body: `${by} marked you ${status} for the ${classLabel(c)}.\n\nReason: ${reason}`,
  data: { sessionId: c.sessionId },
});

export const correctionApproved = (c: ClassRef, correctionId: string, by: string, status: string, note?: string | null): Message => ({
  kind: 'correction.approved',
  title: `Correction approved: ${c.subjectCode}`,
  body: `${by} changed your mark to ${status} for the ${classLabel(c)}.${note ? `\n\n${note}` : ''}`,
  data: { sessionId: c.sessionId, correctionId },
});

export const correctionRejected = (c: ClassRef, correctionId: string, by: string, note: string): Message => ({
  kind: 'correction.rejected',
  title: `Correction turned down: ${c.subjectCode}`,
  body: `${by} turned down your request for the ${classLabel(c)}.\n\n${note}`,
  data: { sessionId: c.sessionId, correctionId },
});

const pct = (p: number) => `${Math.round(p * 10) / 10}%`;

/**
 * How many classes in a row the student must attend to reach the minimum again:
 * the smallest k with (present + k) / (counted + k) ≥ minimum.
 */
export function classesToRecover(present: number, counted: number, minimumPercent: number): number | null {
  if (minimumPercent >= 100) return null;
  return Math.max(0, Math.ceil((minimumPercent * counted - 100 * present) / (100 - minimumPercent)));
}

export function lowAttendance(input: {
  termId: string;
  termName: string;
  minimumPercent: number;
  present: number;
  counted: number;
  percentage: number;
  subjectsBelow: { code: string; name: string; percentage: number }[];
}): Message {
  const recover = classesToRecover(input.present, input.counted, input.minimumPercent);
  const parts = [
    `That's below the ${input.minimumPercent}% minimum for ${input.termName}. You've been present in ${input.present} of ${input.counted} classes.`,
  ];
  if (input.subjectsBelow.length) {
    parts.push(['Subjects below the minimum:', ...input.subjectsBelow.map((s) => `• ${s.code} ${s.name}: ${pct(s.percentage)}`)].join('\n'));
  }
  if (recover) {
    parts.push(`If you attend every class from now on, you'll be back to ${input.minimumPercent}% after ${recover} more class${recover === 1 ? '' : 'es'}.`);
  }
  return {
    kind: 'attendance.low',
    title: `Your attendance is ${pct(input.percentage)}`,
    body: parts.join('\n\n'),
    data: { termId: input.termId },
  };
}

const SCOPE_WORDS = { admin: 'the institute', hod: 'your department and classes', faculty: 'your classes' } as const;

export function weeklySummary(input: {
  role: keyof typeof SCOPE_WORDS;
  termId: string;
  termName: string;
  minimumPercent: number;
  total: number;
  lowest: { fullName: string; rollNo: string | null; className: string; percentage: number | null }[];
}): Message {
  const n = input.total;
  const students = `${n} student${n === 1 ? '' : 's'}`;
  const lines = input.lowest.map(
    (s) => `• ${s.fullName} (${s.rollNo ? `Roll ${s.rollNo}, ` : ''}${s.className}): ${s.percentage === null ? '—' : pct(s.percentage)}`,
  );
  const more = n - input.lowest.length;
  return {
    kind: 'summary.weekly',
    title: `${students} below ${input.minimumPercent}% in ${SCOPE_WORDS[input.role]}`,
    body: [
      `${input.termName}: ${students} in ${SCOPE_WORDS[input.role]} ${n === 1 ? 'is' : 'are'} below the ${input.minimumPercent}% minimum attendance. Lowest first:`,
      lines.join('\n'),
      ...(more > 0 ? [`…and ${more} more. The Reports page has the full list.`] : []),
    ].join('\n\n'),
    data: { termId: input.termId },
  };
}
