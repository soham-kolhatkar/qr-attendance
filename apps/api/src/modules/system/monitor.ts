import type { FastifyBaseLogger } from 'fastify';
import type { EmailSender } from '../notifications/email.js';

export type RecentError = { at: string; where: string; message: string };

/**
 * The useful part of an error: database errors come wrapped in "Failed query: <the SQL>",
 * with the reason (e.g. "connection terminated") on `cause`.
 */
export function errorText(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  const text = cause?.message ?? (err instanceof Error ? err.message : String(err));
  return text.split('\n')[0]!;
}
type Loop = { everyMs: number; lastOkAt?: Date; lastErrorAt?: Date; lastError?: string };

const KEEP_ERRORS = 50;
/** Alert emails go out at most this often (a burst of errors is one email). */
const ALERT_EVERY_MS = 3600_000;
/** A background loop that hasn't succeeded for this many of its intervals is stalled. */
const STALLED_AFTER = 4;

/**
 * What the server knows about its own health, kept in memory so it still works when the
 * database doesn't: recent server errors, and when each background loop last succeeded.
 * Read by /health, the platform owner's System page and the alert emails.
 */
export class Monitor {
  readonly startedAt = new Date();
  readonly version = process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? 'local';
  private readonly loops = new Map<string, Loop>();
  private readonly errors: RecentError[] = [];
  private errorCount = 0;
  private alertedErrorCount = 0;
  private lastAlertAt = 0;

  /** A background loop that should succeed at least every `everyMs`. */
  expect(name: string, everyMs: number) {
    this.loops.set(name, { everyMs });
  }

  ok(name: string, at = new Date()) {
    const loop = this.loops.get(name);
    if (loop) loop.lastOkAt = at;
  }

  failed(name: string, err: unknown, at = new Date()) {
    const message = errorText(err);
    const loop = this.loops.get(name);
    if (loop) Object.assign(loop, { lastErrorAt: at, lastError: message.slice(0, 300) });
    this.recordError(`background: ${name}`, message, at);
  }

  recordError(where: string, message: string, at = new Date()) {
    this.errors.unshift({ at: at.toISOString(), where, message: message.slice(0, 300) });
    this.errors.length = Math.min(this.errors.length, KEEP_ERRORS);
    this.errorCount += 1;
  }

  recentErrors(): RecentError[] {
    return [...this.errors];
  }

  loopStatus(now = new Date()) {
    return [...this.loops].map(([name, l]) => ({
      name,
      everySeconds: l.everyMs / 1000,
      lastOkAt: l.lastOkAt?.toISOString() ?? null,
      lastErrorAt: l.lastErrorAt?.toISOString() ?? null,
      lastError: l.lastError ?? null,
      stalled: this.isStalled(l, now),
    }));
  }

  /** Loops that haven't succeeded for a while (none right after starting). */
  stalled(now = new Date()): string[] {
    return [...this.loops].filter(([, l]) => this.isStalled(l, now)).map(([name]) => name);
  }

  private isStalled(l: Loop, now: Date): boolean {
    const since = (l.lastOkAt ?? this.startedAt).getTime();
    return now.getTime() - since > STALLED_AFTER * l.everyMs;
  }

  /**
   * Emails the platform owner about new errors or stalled loops, at most once an hour.
   * Needs no database, so it also reports the database being down.
   */
  async alert(email: EmailSender | null, to: string[], publicUrl: string | undefined, log?: FastifyBaseLogger, now = new Date()) {
    if (!email || to.length === 0 || now.getTime() - this.lastAlertAt < ALERT_EVERY_MS) return;
    const newErrors = this.errorCount - this.alertedErrorCount;
    const stalled = this.stalled(now);
    if (newErrors === 0 && stalled.length === 0) return;
    this.lastAlertAt = now.getTime();
    this.alertedErrorCount = this.errorCount;
    const lines = [
      ...(stalled.length ? [`Background work has stopped: ${stalled.join(', ')}.`, ''] : []),
      ...(newErrors ? [`${newErrors} server error${newErrors === 1 ? '' : 's'} since the last alert. The latest:`, ''] : []),
      ...this.errors.slice(0, 10).map((e) => `• ${e.at} ${e.where}: ${e.message}`),
      '',
      `Server version ${this.version}, running since ${this.startedAt.toISOString()}.`,
      ...(publicUrl ? [`More on the System page: ${new URL('/platform/system', publicUrl).toString()}`] : []),
    ];
    const subject = stalled.length ? 'QR Attendance: background work has stopped' : `QR Attendance: ${newErrors} server error${newErrors === 1 ? '' : 's'}`;
    for (const address of to) {
      await email
        .send({ to: { email: address, name: 'Platform owner' }, subject, text: lines.join('\n'), html: `<pre style="font-family:inherit;white-space:pre-wrap">${escape(lines.join('\n'))}</pre>` })
        .catch((err: unknown) => log?.error({ err }, 'alert email failed'));
    }
  }
}

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
