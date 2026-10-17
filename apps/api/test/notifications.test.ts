import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobRuns, notifications, pushTokens, users } from '../src/db/schema.js';
import { type Delivery, deliverNotifications } from '../src/modules/notifications/delivery.js';
import { DeliveryError, type Email, renderEmail } from '../src/modules/notifications/email.js';
import { localTime, runScheduledJobs } from '../src/modules/notifications/jobs.js';
import { classesToRecover } from '../src/modules/notifications/messages.js';
import type { PushMessage } from '../src/modules/notifications/push.js';
import { notify } from '../src/modules/notifications/service.js';
import { as, expectStatus, loginStudent, setupClass, signedScan, useTestApp } from './helpers.js';

const ctx = useTestApp();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Fake email and push that record what they were asked to send. */
function fakeDelivery(overrides: Partial<Delivery> = {}) {
  const emails: Email[] = [];
  const pushes: { token: string; message: PushMessage }[] = [];
  const delivery: Delivery = {
    email: { send: async (e) => void emails.push(e) },
    push: {
      send: async (token, message) => {
        if (token.startsWith('gone')) return 'invalid';
        pushes.push({ token, message });
        return 'ok';
      },
    },
    emailDailyLimit: 300,
    publicUrl: 'https://attendance.example.com',
    ...overrides,
  };
  return { delivery, emails, pushes };
}

const TOKEN = 'fcm-token-0123456789-abcdefghij';

describe('notifications', () => {
  it('lists, counts and marks read; only changes that alter a mark notify', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const student = as(ctx.app, await loginStudent(ctx.app, 'ca01'));
    const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
    const mark = async (status: string, reason: string) =>
      expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a1], status, reason }), 200);

    await mark('absent', 'Still absent'); // was absent already: nothing to tell
    expect(expectStatus(await student.get('/v1/notifications/unread-count'), 200).count).toBe(0);
    await mark('present', 'Phone not working');
    await mark('excused', 'Medical leave');

    const list = expectStatus(await student.get('/v1/notifications'), 200);
    expect(list.unread).toBe(2);
    expect(list.items.map((n: { body: string }) => n.body.split('\n\n')[1])).toEqual(['Reason: Medical leave', 'Reason: Phone not working']);
    expect(list.items[0]).toMatchObject({ kind: 'attendance.changed', read: false, data: { sessionId: session.id } });

    // Paging: older than the newest one.
    const older = expectStatus(await student.get(`/v1/notifications?before=${encodeURIComponent(list.items[0].createdAt)}`), 200);
    expect(older.items).toHaveLength(1);

    expect(expectStatus(await student.post('/v1/notifications/read', { ids: [list.items[0].id] }), 200).unread).toBe(1);
    expect(expectStatus(await student.get('/v1/notifications?unread=true'), 200).items).toHaveLength(1);
    expect(expectStatus(await student.post('/v1/notifications/read', {}), 200).unread).toBe(0);

    // Nobody else sees them.
    const other = as(ctx.app, await loginStudent(ctx.app, 'ca02'));
    expect(expectStatus(await other.get('/v1/notifications'), 200).items).toHaveLength(0);
    expectStatus(await other.post('/v1/notifications/read', { ids: [list.items[0].id] }), 200);
  });

  it('push registrations follow whoever signs in on the phone', async () => {
    await setupClass(ctx.app, ctx.db);
    const ca01 = as(ctx.app, await loginStudent(ctx.app, 'ca01'));
    const ca02 = as(ctx.app, await loginStudent(ctx.app, 'ca02'));
    expectStatus(await ca01.post('/v1/notifications/push-tokens', { token: TOKEN, platform: 'android' }), 204);
    expectStatus(await ca02.post('/v1/notifications/push-tokens', { token: TOKEN, platform: 'android' }), 204);
    const [row] = await ctx.db.select().from(pushTokens);
    const [ca02Row] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.username, 'ca02'));
    expect(row!.userId).toBe(ca02Row!.id);

    expectStatus(await ca01.post('/v1/notifications/push-tokens/remove', { token: TOKEN }), 204); // not theirs any more
    expect(await ctx.db.select().from(pushTokens)).toHaveLength(1);
    expectStatus(await ca02.post('/v1/notifications/push-tokens/remove', { token: TOKEN }), 204);
    expect(await ctx.db.select().from(pushTokens)).toHaveLength(0);

    expect(expectStatus(await ca01.get('/v1/notifications/channels'), 200)).toEqual({ email: false, push: false });
  });

  it('delivers by push and email, drops dead phones, retries failures and keeps to the daily email limit', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const [a1, a2] = [c.students.a1, c.students.a2];
    const instituteId = (await ctx.db.select({ i: users.instituteId }).from(users).where(eq(users.id, a1)))[0]!.i!;
    await ctx.db.update(users).set({ email: 'ca01@example.com' }).where(eq(users.id, a1));
    await ctx.db.insert(pushTokens).values([
      { token: TOKEN, userId: a1, instituteId, platform: 'android' },
      { token: 'gone-token-0123456789-abcdef', userId: a1, instituteId, platform: 'android' },
    ]);
    const low = { kind: 'attendance.low' as const, title: 'Your attendance is 60%', body: 'Below.\n\n• CS301 Data Structures: 60%' };
    const now = new Date();
    await notify(
      ctx.db,
      [
        { instituteId, userId: a1, ...low },
        { instituteId, userId: a2, ...low }, // no email address, no phone
        { instituteId, userId: a1, kind: 'attendance.changed', title: 'Attendance changed', body: 'x', data: { sessionId: c.offering.id } },
      ],
      now,
    );

    const fake = fakeDelivery();
    expect((await deliverNotifications(ctx.db, fake.delivery, now)).processed).toBe(3);
    expect(fake.pushes).toHaveLength(2);
    expect(fake.pushes.map((p) => p.message)).toContainEqual(
      expect.objectContaining({ title: 'Your attendance is 60%', data: expect.objectContaining({ kind: 'attendance.low' }) }),
    );
    expect(await ctx.db.select({ token: pushTokens.token }).from(pushTokens)).toEqual([{ token: TOKEN }]); // the dead one is gone
    expect(fake.emails).toHaveLength(1);
    expect(fake.emails[0]).toMatchObject({ to: { email: 'ca01@example.com', name: 'Student ca01' }, subject: 'Your attendance is 60%' });
    expect(fake.emails[0]!.html).toContain('<li>CS301 Data Structures: 60%</li>');
    expect(fake.emails[0]!.html).toContain('href="https://attendance.example.com/profile"');

    const rows = await ctx.db.select().from(notifications);
    const status = (userId: string, kind: string) => rows.find((r) => r.userId === userId && r.kind === kind)!;
    expect(status(a1, 'attendance.low')).toMatchObject({ pushStatus: 'sent', emailStatus: 'sent' });
    expect(status(a2, 'attendance.low')).toMatchObject({ pushStatus: 'skipped', emailStatus: 'skipped' });
    expect(status(a1, 'attendance.changed')).toMatchObject({ pushStatus: 'sent', emailStatus: null });
    expect((await deliverNotifications(ctx.db, fake.delivery, now)).processed).toBe(0);

    // A provider outage: retried later with a back-off, then given up after 5 tries.
    await notify(ctx.db, [{ instituteId, userId: a1, ...low }], now);
    const down = fakeDelivery({
      email: {
        send: async () => {
          throw new DeliveryError('Brevo 503');
        },
      },
    });
    let at = new Date(now.getTime() + 1000);
    await deliverNotifications(ctx.db, down.delivery, at);
    const [retrying] = await ctx.db.select().from(notifications).where(eq(notifications.emailStatus, 'pending'));
    expect(retrying).toMatchObject({ attempts: 1, pushStatus: 'sent', lastError: 'Brevo 503' });
    expect(retrying!.nextAttemptAt.getTime()).toBe(at.getTime() + 60_000);
    expect((await deliverNotifications(ctx.db, down.delivery, at)).processed).toBe(0); // not due yet
    for (let i = 0; i < 4; i++) {
      at = new Date(at.getTime() + 3 * HOUR);
      await deliverNotifications(ctx.db, down.delivery, at);
    }
    expect((await ctx.db.select().from(notifications).where(eq(notifications.id, retrying!.id)))[0]).toMatchObject({
      emailStatus: 'failed',
      attempts: 5,
    });

    // A bad address won't get better: failed at once.
    await notify(ctx.db, [{ instituteId, userId: a1, ...low }], at);
    const bad = fakeDelivery({
      email: {
        send: async () => {
          throw new DeliveryError('Brevo 400: invalid email', true);
        },
      },
    });
    await deliverNotifications(ctx.db, bad.delivery, at);
    expect(await ctx.db.select().from(notifications).where(eq(notifications.emailStatus, 'pending'))).toHaveLength(0);

    // Over today's email limit: held until tomorrow (UTC), then sent.
    await notify(ctx.db, [{ instituteId, userId: a1, ...low }], now);
    const limited = fakeDelivery({ emailDailyLimit: 1 });
    await deliverNotifications(ctx.db, limited.delivery, now);
    expect(limited.emails).toHaveLength(0); // one already went out today
    const [held] = await ctx.db.select().from(notifications).where(eq(notifications.emailStatus, 'pending'));
    expect(held!.nextAttemptAt.toISOString().slice(11)).toBe('00:00:00.000Z');
    await deliverNotifications(ctx.db, limited.delivery, new Date(held!.nextAttemptAt.getTime() + 1000));
    expect(limited.emails).toHaveLength(1);

    // Nothing set up on the server: everything is skipped, nothing waits forever.
    await notify(ctx.db, [{ instituteId, userId: a1, ...low }], at);
    await deliverNotifications(ctx.db, { email: null, push: null, emailDailyLimit: 300 }, at);
    expect(await ctx.db.select().from(notifications).where(eq(notifications.pushStatus, 'pending'))).toHaveLength(0);
  });

  it('reminds students below the minimum once a week and sends staff a Monday summary', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    // Six classes: ca01 always there, ca02 in 4 (67%), ca03 in 1 (17%). Div B (cb01) has no classes.
    const ca01 = await loginStudent(ctx.app, 'ca01');
    for (let i = 0; i < 6; i++) {
      const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
      const { payload } = expectStatus(await prof.get(`/v1/sessions/${session.id}/qr`), 200);
      expectStatus(await signedScan(ctx, ca01, payload), 200);
      const present = [...(i < 4 ? [c.students.a2] : []), ...(i === 0 ? [c.students.a3] : [])];
      if (present.length) expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: present, status: 'present', reason: 'Test' }), 200);
      expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
    }
    // Leave out the "attendance changed" notifications from the marks above.
    await ctx.db.delete(notifications);

    // The next Monday, 18:00 in India.
    const base = new Date(Date.now() + ctx.clockOffsetMs);
    let monday = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 12, 30)); // 18:00 IST
    while (localTime('Asia/Kolkata', monday).weekday !== 1 || monday <= base) monday = new Date(monday.getTime() + DAY);
    expect(localTime('Asia/Kolkata', monday)).toMatchObject({ hour: 18, weekday: 1 });

    await runScheduledJobs(ctx.db, monday);
    const sent = await ctx.db.select().from(notifications);
    const low = sent.filter((n) => n.kind === 'attendance.low');
    expect(low.map((n) => n.userId).sort()).toEqual([c.students.a2, c.students.a3].sort());
    const kabir = low.find((n) => n.userId === c.students.a3)!;
    expect(kabir).toMatchObject({ title: 'Your attendance is 16.7%', emailStatus: 'pending', pushStatus: 'pending' });
    expect(kabir.body).toBe(
      [
        "That's below the 75% minimum for Odd. You've been present in 1 of 6 classes.",
        'Subjects below the minimum:\n• CS301 Data Structures: 16.7%',
        "If you attend every class from now on, you'll be back to 75% after 14 more classes.",
      ].join('\n\n'),
    );

    // Staff: the teacher and the admin see both students; prof.b teaches nobody below.
    const summaries = sent.filter((n) => n.kind === 'summary.weekly');
    expect(summaries.map((n) => n.title).sort()).toEqual(['2 students below 75% in the institute', '2 students below 75% in your classes']);
    const profSummary = summaries.find((n) => n.userId === c.prof.id)!;
    expect(profSummary.body).toContain('• Student ca03 (Roll 3, Computer Engineering › SY › Div A): 16.7%\n• Student ca02 (Roll 2, Computer Engineering › SY › Div A): 66.7%');
    expect(profSummary).toMatchObject({ emailStatus: 'pending', pushStatus: null });

    // Once per day / week, even when run again; reminders at most weekly.
    await runScheduledJobs(ctx.db, new Date(monday.getTime() + HOUR));
    await runScheduledJobs(ctx.db, new Date(monday.getTime() + DAY)); // Tuesday: low-attendance runs again, nobody is due
    expect(await ctx.db.select().from(notifications)).toHaveLength(sent.length);
    expect((await ctx.db.select().from(jobRuns)).map((j) => j.job).sort()).toEqual(['low_attendance', 'low_attendance', 'weekly_summary']);
    await runScheduledJobs(ctx.db, new Date(monday.getTime() + 7 * DAY)); // a week on: reminded again, and a new summary
    expect(await ctx.db.select().from(notifications)).toHaveLength(sent.length * 2);

    // Before 17:00 nothing goes to students; switched off, nothing at all.
    await ctx.db.delete(notifications);
    await ctx.db.delete(jobRuns);
    await runScheduledJobs(ctx.db, new Date(monday.getTime() - 2 * HOUR)); // Monday 16:00: only the staff summary
    expect(new Set((await ctx.db.select().from(notifications)).map((n) => n.kind))).toEqual(new Set(['summary.weekly']));
    await ctx.db.delete(notifications);
    await ctx.db.delete(jobRuns);
    expectStatus(await as(ctx.app, c.admin).patch('/v1/settings/attendance', { lowAttendanceAlerts: false, weeklyStaffSummary: false }), 200);
    await runScheduledJobs(ctx.db, monday);
    expect(await ctx.db.select().from(notifications)).toHaveLength(0);
  });

  it('works out local time, ISO weeks and how many classes it takes to recover', () => {
    // Sunday 3 Jan 2027 is in ISO week 53 of 2026; Monday 4 Jan starts week 1 of 2027.
    expect(localTime('Asia/Kolkata', new Date('2027-01-03T12:00:00Z'))).toEqual({ date: '2027-01-03', hour: 17, weekday: 7, isoWeek: '2026-W53' });
    expect(localTime('Asia/Kolkata', new Date('2027-01-03T19:00:00Z'))).toMatchObject({ date: '2027-01-04', weekday: 1, isoWeek: '2027-W01' });
    expect(classesToRecover(1, 6, 75)).toBe(14); // (1+14)/(6+14) = 75%
    expect(classesToRecover(4, 6, 75)).toBe(2); // 6/8
    expect(classesToRecover(9, 10, 75)).toBe(0);
    expect(classesToRecover(1, 2, 100)).toBeNull();
    const email = renderEmail({ to: { email: 'a@b.c', name: 'Asha <A>' }, title: 'T', body: 'Hello\n\n• one\n• two', institute: 'X' });
    expect(email.html).toContain('Hi Asha &lt;A&gt;,');
    expect(email.text).toBe('Hi Asha <A>,\n\nHello\n\n• one\n• two\n\n--\nSent by QR Attendance for X.');
  });
});
