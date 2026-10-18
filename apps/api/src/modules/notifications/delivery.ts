import { and, count, eq, gte, inArray, lte, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { institutes, notifications, pushTokens, users } from '../../db/schema.js';
import { DeliveryError, type EmailSender, renderEmail } from './email.js';
import type { PushSender } from './push.js';
import type { NotificationKind } from './service.js';

/** How the server reaches people besides the in-app list. A null channel isn't set up. */
export type Delivery = {
  email: EmailSender | null;
  push: PushSender | null;
  /** Emails per UTC day at most; the rest wait for the next day. */
  emailDailyLimit: number;
  /** The web app's address, for links in emails. */
  publicUrl?: string;
};

type Status = 'pending' | 'sent' | 'failed' | 'skipped';

const MAX_ATTEMPTS = 5;
/** Wait before retry n (1-based). */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
/** A claimed message is someone's for this long; if that server dies, another picks it up afterwards. */
const LEASE_MS = 5 * 60_000;
/** Emails held back by the daily limit for longer than this are dropped (the news is stale by then). */
const EMAIL_MAX_AGE_MS = 3 * 24 * 3600_000;

/** Links in emails, by kind. */
const EMAIL_LINKS: Partial<Record<NotificationKind, { label: string; path: string }>> = {
  'summary.weekly': { label: 'Open reports', path: '/reports' },
  'attendance.low': { label: 'See your attendance', path: '/profile' },
  'webhook.disabled': { label: 'Open Integrations', path: '/integrations' },
};

const startOfUtcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/**
 * Sends notifications waiting in the outbox by email and push. Safe to run on several
 * servers at once: each claims its batch with a short lease before sending.
 */
export async function deliverNotifications(
  db: Db,
  delivery: Delivery,
  now: Date,
  log?: FastifyBaseLogger,
  limit = 50,
): Promise<{ processed: number }> {
  const due = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(or(eq(notifications.emailStatus, 'pending'), eq(notifications.pushStatus, 'pending')), lte(notifications.nextAttemptAt, now)))
    .orderBy(notifications.nextAttemptAt)
    .limit(limit)
    .for('update', { skipLocked: true });
  const claimed = await db
    .update(notifications)
    .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
    .where(inArray(notifications.id, due))
    .returning();
  if (claimed.length === 0) return { processed: 0 };

  const userIds = [...new Set(claimed.map((n) => n.userId))];
  const people = new Map(
    (
      await db
        .select({ id: users.id, email: users.email, fullName: users.fullName, status: users.status, institute: institutes.name })
        .from(users)
        .innerJoin(institutes, eq(institutes.id, users.instituteId))
        .where(inArray(users.id, userIds))
    ).map((u) => [u.id, u]),
  );
  const tokens = new Map<string, string[]>();
  for (const t of await db.select().from(pushTokens).where(inArray(pushTokens.userId, userIds))) {
    tokens.set(t.userId, [...(tokens.get(t.userId) ?? []), t.token]);
  }
  const [sentToday] = await db
    .select({ n: count() })
    .from(notifications)
    .where(gte(notifications.emailedAt, startOfUtcDay(now)));
  let emailBudget = delivery.emailDailyLimit - (sentToday?.n ?? 0);

  for (const n of claimed) {
    const person = people.get(n.userId);
    let pushStatus: Status | null = n.pushStatus;
    let emailStatus: Status | null = n.emailStatus;
    let emailedAt: Date | null = null;
    let retryAt: Date | null = null;
    const errors: string[] = [];
    let transient = false;

    // A failure that isn't permanent keeps the channel pending for another try, until attempts run out.
    const failed = (err: unknown): Status => {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      if (err instanceof DeliveryError && err.permanent) return 'failed';
      transient = true;
      return n.attempts + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending';
    };

    if (pushStatus === 'pending') {
      const list = tokens.get(n.userId) ?? [];
      if (!delivery.push || !person || person.status !== 'active') pushStatus = 'skipped';
      else if (list.length === 0) pushStatus = 'skipped';
      else {
        let delivered = false;
        let error: unknown = null;
        for (const token of list) {
          try {
            const result = await delivery.push.send(token, {
              title: n.title,
              body: n.body,
              data: { notificationId: n.id, kind: n.kind, ...(n.data as Record<string, string>) },
            });
            if (result === 'ok') delivered = true;
            else await db.delete(pushTokens).where(eq(pushTokens.token, token));
          } catch (err) {
            error = err;
          }
        }
        pushStatus = delivered ? 'sent' : error ? failed(error) : 'skipped';
      }
    }

    if (emailStatus === 'pending') {
      if (!delivery.email || !person?.email || person.status !== 'active') emailStatus = 'skipped';
      else if (emailBudget <= 0) {
        if (now.getTime() - n.createdAt.getTime() > EMAIL_MAX_AGE_MS) {
          emailStatus = 'skipped';
          errors.push('Daily email limit reached');
        } else {
          retryAt = new Date(startOfUtcDay(now).getTime() + 24 * 3600_000);
        }
      } else {
        const link = EMAIL_LINKS[n.kind as NotificationKind];
        try {
          await delivery.email.send(
            renderEmail({
              to: { email: person.email, name: person.fullName },
              title: n.title,
              body: n.body,
              institute: person.institute,
              link: link && delivery.publicUrl ? { label: link.label, url: new URL(link.path, delivery.publicUrl).toString() } : undefined,
            }),
          );
          emailStatus = 'sent';
          emailedAt = now;
          emailBudget -= 1;
        } catch (err) {
          emailStatus = failed(err);
        }
      }
    }

    const attempts = transient ? n.attempts + 1 : n.attempts;
    if (transient && (pushStatus === 'pending' || emailStatus === 'pending')) {
      const backoff = new Date(now.getTime() + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!);
      // Whichever channel is due first; a held-back email just waits again if it's still too early.
      retryAt = retryAt && retryAt < backoff ? retryAt : backoff;
    }
    if (errors.length) log?.warn({ notificationId: n.id, errors }, 'notification delivery problem');
    await db
      .update(notifications)
      .set({
        pushStatus,
        emailStatus,
        attempts,
        ...(emailedAt && { emailedAt }),
        nextAttemptAt: retryAt ?? now,
        lastError: errors.length ? errors.join('; ').slice(0, 1000) : n.lastError,
      })
      .where(eq(notifications.id, n.id));
  }
  return { processed: claimed.length };
}
