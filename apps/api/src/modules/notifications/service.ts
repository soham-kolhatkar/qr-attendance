import { and, count, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { type NotificationData, notifications, pushTokens } from '../../db/schema.js';
import type { InstituteAuthContext } from '../../plugins/auth.js';

/**
 * What each kind of notification is for, and how it travels besides the in-app list.
 * Students get the phone alerts; staff get the weekly email (they rarely have the app).
 */
export const NOTIFICATION_KINDS = {
  /** A teacher changed the student's mark by hand. */
  'attendance.changed': { push: true, email: false },
  /** The student's correction request was approved (or settled by a mark by hand). */
  'correction.approved': { push: true, email: false },
  'correction.rejected': { push: true, email: false },
  /** The student is below the minimum; at most once a week. */
  'attendance.low': { push: true, email: true },
  /** Monday summary for teachers, HODs and admins: students below the minimum. */
  'summary.weekly': { push: false, email: true },
  /** To admins: a webhook endpoint failed for a day and was switched off. */
  'webhook.disabled': { push: false, email: true },
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export type NewNotification = {
  instituteId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  data?: NotificationData;
};

/** Adds notifications (in the caller's transaction); email and push go out shortly after, from the outbox. */
export async function notify(db: DbOrTx, list: NewNotification[], now: Date): Promise<void> {
  for (let i = 0; i < list.length; i += 1000) {
    await db.insert(notifications).values(
      list.slice(i, i + 1000).map((n) => ({
        ...n,
        data: n.data ?? {},
        createdAt: now,
        nextAttemptAt: now,
        emailStatus: NOTIFICATION_KINDS[n.kind].email ? ('pending' as const) : null,
        pushStatus: NOTIFICATION_KINDS[n.kind].push ? ('pending' as const) : null,
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// The in-app list
// ---------------------------------------------------------------------------

export type NotificationDto = {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: NotificationData;
  read: boolean;
  createdAt: string;
};

const mine = (auth: InstituteAuthContext) => eq(notifications.userId, auth.userId);

export async function unreadCount(db: DbOrTx, auth: InstituteAuthContext): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(mine(auth), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** Newest first, a page at a time (`before` = the createdAt of the last one already shown). */
export async function listNotifications(
  db: Db,
  auth: InstituteAuthContext,
  query: { limit: number; before?: string; unread?: boolean },
): Promise<{ items: NotificationDto[]; unread: number }> {
  const conditions: (SQL | undefined)[] = [mine(auth)];
  if (query.before) conditions.push(lt(notifications.createdAt, new Date(query.before)));
  if (query.unread) conditions.push(isNull(notifications.readAt));
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(query.limit);
  return {
    items: rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      data: n.data,
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
    })),
    unread: await unreadCount(db, auth),
  };
}

/** Marks the given notifications read, or all of them when `ids` is omitted. Returns the unread count left. */
export async function markRead(db: Db, auth: InstituteAuthContext, ids: string[] | undefined, now: Date): Promise<number> {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(mine(auth), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined));
  return unreadCount(db, auth);
}

// ---------------------------------------------------------------------------
// Phones that receive push notifications
// ---------------------------------------------------------------------------

/** The app registers its push address after sign-in. A phone passed to another student moves with them. */
export async function registerPushToken(db: Db, auth: InstituteAuthContext, input: { token: string; platform: 'android' | 'ios' }) {
  await db
    .insert(pushTokens)
    .values({ token: input.token, platform: input.platform, userId: auth.userId, instituteId: auth.instituteId })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: { userId: auth.userId, instituteId: auth.instituteId, platform: input.platform, updatedAt: new Date() },
    });
}

/** On sign-out, so the phone stops getting this user's notifications. */
export async function removePushToken(db: Db, auth: InstituteAuthContext, token: string) {
  await db.delete(pushTokens).where(and(eq(pushTokens.token, token), eq(pushTokens.userId, auth.userId)));
}
