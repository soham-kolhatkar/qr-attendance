import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { as, createUserAs, expectStatus, login, loginStudent, setupClass, setupInstitute, type Tokens, useTestApp } from './helpers.js';

const ctx = useTestApp();
const DAY = 24 * 3600 * 1000;

/**
 * COMP SY Div A: ca01, ca02 (batch A1), ca03 (batch A2); Div B: cb01.
 * CS301 (prof.a) is taught to Div A; CS302 (prof.b) to Div B.
 * Attendance, oldest first:
 *   CS301 #1: ca01 P, ca02 P, ca03 A
 *   CS301 #2: ca01 P, ca02 A, ca03 A
 *   CS301 #3: ca01 P, ca02 E, ca03 P
 *   CS301 lab for A1 only: ca01 A, ca02 P
 *   CS302 #1: cb01 P
 *   CS301 cancelled (all present) and CS301 still open (ca01 P): not counted
 * So ca01 3/4 = 75%, ca02 2/3 = 66.7%, ca03 1/3 = 33.3%, cb01 1/1 = 100%.
 */
async function setupReport() {
  const c = await setupClass(ctx.app, ctx.db);
  const admin = as(ctx.app, c.admin);
  const cs302 = expectStatus(await admin.post('/v1/subjects', { code: 'CS302', name: 'DBMS', unitId: c.s.comp }), 201);
  const profB = (await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.b' })) as Tokens;
  const profBId = expectStatus(await as(ctx.app, profB).get('/v1/me'), 200).user.id as string;
  const offering302 = expectStatus(
    await admin.post('/v1/offerings', { termId: c.term.id, subjectId: cs302.id, facultyIds: [profBId], audience: { unitIds: [c.s.compB] } }),
    201,
  );

  const run = async (
    teacher: Tokens,
    body: object,
    marks: Partial<Record<'present' | 'excused', string[]>>,
    end: 'close' | 'cancel' | 'open' = 'close',
  ) => {
    ctx.advance(DAY); // one session a day
    const api = as(ctx.app, teacher);
    const session = expectStatus(await api.post('/v1/sessions', body), 201);
    for (const [status, studentIds] of Object.entries(marks)) {
      if (studentIds.length) expectStatus(await api.post(`/v1/sessions/${session.id}/mark`, { studentIds, status, reason: 'Test data' }), 200);
    }
    if (end === 'close') expectStatus(await api.post(`/v1/sessions/${session.id}/close`), 200);
    if (end === 'cancel') expectStatus(await api.post(`/v1/sessions/${session.id}/cancel`, { reason: 'Wrong class' }), 200);
    return session.id as string;
  };
  const s = c.students;
  const o = c.offering.id;
  await run(c.profTokens, { offeringId: o }, { present: [s.a1, s.a2] });
  await run(c.profTokens, { offeringId: o }, { present: [s.a1] });
  await run(c.profTokens, { offeringId: o }, { present: [s.a1, s.a3], excused: [s.a2] });
  const lab = await run(c.profTokens, { offeringId: o, kind: 'lab', audience: { groupIds: [c.s.a1] } }, { present: [s.a2] });
  await run(profB, { offeringId: offering302.id }, { present: [s.b1] });
  await run(c.profTokens, { offeringId: o }, { present: [s.a1, s.a2, s.a3] }, 'cancel');
  await run(c.profTokens, { offeringId: o }, { present: [s.a1] }, 'open');
  return { ...c, profB, cs302, offering302, lab };
}

describe('reports', () => {
  it('summarises the term: overall, defaulters, by class, by subject, by day and hour', async () => {
    const c = await setupReport();
    const summary = expectStatus(await as(ctx.app, c.admin).get('/v1/reports/summary'), 200);
    expect(summary.term.id).toBe(c.term.id);
    expect(summary.minimumPercent).toBe(75);
    // 7 present of 12 records, 1 excused → 7/11.
    expect(summary.overall).toEqual({ present: 7, absent: 4, excused: 1, total: 12, percentage: 63.6 });
    expect(summary.sessions).toBe(5);
    expect(summary.students).toEqual({ total: 4, below: 2 });
    expect(summary.byUnit).toEqual([
      expect.objectContaining({ path: ['Computer Engineering', 'SY', 'Div A'], students: 3, below: 2, present: 6, total: 11 }),
      expect.objectContaining({ path: ['Computer Engineering', 'SY', 'Div B'], students: 1, below: 0, percentage: 100 }),
    ]);
    expect(summary.bySubject).toEqual([
      expect.objectContaining({ code: 'CS301', sessions: 4, students: 3, below: 2 }),
      expect.objectContaining({ code: 'CS302', sessions: 1, students: 1, below: 0 }),
    ]);
    expect(summary.trend).toHaveLength(5);
    expect(summary.trend.reduce((n: number, d: { sessions: number }) => n + d.sessions, 0)).toBe(5);
    expect(summary.heatmap.reduce((n: number, h: { sessions: number }) => n + h.sessions, 0)).toBe(5);
    for (const h of summary.heatmap) {
      expect(h.weekday).toBeGreaterThanOrEqual(1);
      expect(h.weekday).toBeLessThanOrEqual(7);
    }

    // Filters: one class, one subject, one batch.
    const divB = expectStatus(await as(ctx.app, c.admin).get(`/v1/reports/summary?unitId=${c.s.compB}`), 200);
    expect(divB.overall.percentage).toBe(100);
    const cs301 = expectStatus(await as(ctx.app, c.admin).get(`/v1/reports/summary?subjectId=${c.subject.id}`), 200);
    expect(cs301.students.total).toBe(3);
    const a1 = expectStatus(await as(ctx.app, c.admin).get(`/v1/reports/summary?groupId=${c.s.a1}`), 200);
    expect(a1.students.total).toBe(2);
  });

  it('lists defaulters, worst first, and every student in roll order', async () => {
    const c = await setupReport();
    const admin = as(ctx.app, c.admin);
    const below = expectStatus(await admin.get('/v1/reports/students?below=true'), 200);
    expect(below.total).toBe(2);
    expect(below.items.map((r: { student: { username: string } }) => r.student.username)).toEqual(['ca03', 'ca02']);
    expect(below.items[1]).toMatchObject({ present: 2, excused: 1, total: 4, percentage: 66.7, below: true });

    const all = expectStatus(await admin.get('/v1/reports/students?pageSize=2'), 200);
    expect(all.total).toBe(4);
    expect(all.items.map((r: { student: { username: string } }) => r.student.username)).toEqual(['ca01', 'ca02']);
    const page2 = expectStatus(await admin.get('/v1/reports/students?pageSize=2&page=2'), 200);
    expect(page2.items.map((r: { student: { username: string } }) => r.student.username)).toEqual(['ca03', 'cb01']);
    // Exactly at the minimum is not below it.
    expect(all.items[0]).toMatchObject({ percentage: 75, below: false });

    const search = expectStatus(await admin.get('/v1/reports/students?q=cb0'), 200);
    expect(search.items).toHaveLength(1);

    // Raising the minimum changes who is a defaulter.
    expectStatus(await admin.patch('/v1/settings/attendance', { minimumPercent: 80 }), 200);
    expect(expectStatus(await admin.get('/v1/reports/students?below=true'), 200).total).toBe(3);
    const mine = expectStatus(await as(ctx.app, await loginStudent(ctx.app, 'ca01')).get('/v1/attendance/mine'), 200);
    expect(mine.minimumPercent).toBe(80);
  });

  it('shows one student by subject and session', async () => {
    const c = await setupReport();
    const report = expectStatus(await as(ctx.app, c.admin).get(`/v1/reports/students/${c.students.a2}`), 200);
    expect(report.student).toMatchObject({ username: 'ca02', unitPath: ['Computer Engineering', 'SY', 'Div A'] });
    expect(report.overall).toMatchObject({ present: 2, excused: 1, total: 4, percentage: 66.7 });
    expect(report.subjects).toEqual([expect.objectContaining({ code: 'CS301', total: 4 })]);
    expect(report.sessions).toHaveLength(4);
    expect(report.sessions[0]).toMatchObject({ kind: 'lab', status: 'present', method: 'manual', reason: 'Test data' });
  });

  it('builds the class register, with open sessions shown but not counted', async () => {
    const c = await setupReport();
    const register = expectStatus(await as(ctx.app, c.profTokens).get(`/v1/reports/offerings/${c.offering.id}/register`), 200);
    expect(register.offering).toMatchObject({ subject: { code: 'CS301' }, faculty: ['Prof A'] });
    expect(register.sessions).toHaveLength(5); // cancelled one left out
    expect(register.sessions.map((s: { open: boolean }) => s.open)).toEqual([false, false, false, false, true]);
    const byName = Object.fromEntries(register.students.map((s: { username: string }) => [s.username, s]));
    expect(byName.ca01.marks).toEqual(['present', 'present', 'present', 'absent', 'present']);
    expect(byName.ca01).toMatchObject({ present: 3, total: 4, percentage: 75, below: false });
    // ca03 is in batch A2, so wasn't on the A1 lab's list.
    expect(byName.ca03.marks[3]).toBeNull();
    expect(byName.ca03).toMatchObject({ total: 3, percentage: 33.3, below: true });
  });

  it('keeps each role to its part of the institute', async () => {
    const c = await setupReport();
    // Faculty: only the classes they teach.
    const profA = expectStatus(await as(ctx.app, c.profTokens).get('/v1/reports/summary'), 200);
    expect(profA.bySubject.map((s: { code: string }) => s.code)).toEqual(['CS301']);
    expect(profA.students.total).toBe(3);
    const profB = expectStatus(await as(ctx.app, c.profB).get('/v1/reports/students'), 200);
    expect(profB.items.map((r: { student: { username: string } }) => r.student.username)).toEqual(['cb01']);
    expect((await as(ctx.app, c.profB).get(`/v1/reports/students/${c.students.a1}`)).statusCode).toBe(404);
    expect((await as(ctx.app, c.profB).get(`/v1/reports/offerings/${c.offering.id}/register`)).statusCode).toBe(404);

    // HOD: their department's students.
    await createUserAs(ctx.app, c.admin, { role: 'hod', username: 'hod.comp', unitId: c.s.comp });
    await createUserAs(ctx.app, c.admin, { role: 'hod', username: 'hod.mech', unitId: c.s.mech });
    const comp = await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.comp' });
    const mech = await login(ctx.app, { instituteCode: 'ALPHA', username: 'hod.mech' });
    expect(expectStatus(await as(ctx.app, comp).get('/v1/reports/summary'), 200).students.total).toBe(4);
    expect(expectStatus(await as(ctx.app, mech).get('/v1/reports/summary'), 200).students.total).toBe(0);
    expect((await as(ctx.app, mech).get(`/v1/reports/students/${c.students.a1}`)).statusCode).toBe(404);

    // Students and other institutes: nothing.
    expect((await as(ctx.app, await loginStudent(ctx.app, 'ca01')).get('/v1/reports/summary')).statusCode).toBe(403);
    const other = await setupInstitute(ctx.app, ctx.db, 'BETA');
    expect((await as(ctx.app, other.admin).get(`/v1/reports/summary?termId=${c.term.id}`)).statusCode).toBe(404);
    expect((await as(ctx.app, other.admin).get(`/v1/reports/offerings/${c.offering.id}/register`)).statusCode).toBe(404);
    expect(expectStatus(await as(ctx.app, other.admin).get('/v1/reports/summary'), 200).term).toBeNull();
  });

  it('exports the defaulter list and the register as Excel and PDF', async () => {
    const c = await setupReport();
    const admin = as(ctx.app, c.admin);

    const xlsx = await admin.get('/v1/reports/students/export?format=xlsx&below=true');
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-disposition']).toBe('attachment; filename="defaulters-odd.xlsx"');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer);
    const sheet = book.getWorksheet('Attendance')!;
    expect(sheet.getRow(1).getCell(11).value).toBe('CS301 %');
    expect(sheet.rowCount).toBe(3);
    expect(sheet.getRow(2).getCell(3).value).toBe('Student ca03');
    expect(Number(sheet.getRow(2).getCell(9).value)).toBeCloseTo(0.333, 3);
    expect(book.getWorksheet('About')).toBeDefined();

    const pdf = await admin.get('/v1/reports/students/export?format=pdf');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const reg = await as(ctx.app, c.profTokens).get(`/v1/reports/offerings/${c.offering.id}/register/export?format=xlsx`);
    const regBook = new ExcelJS.Workbook();
    await regBook.xlsx.load(reg.rawPayload as unknown as ArrayBuffer);
    const regSheet = regBook.getWorksheet('Register')!;
    expect(regSheet.rowCount).toBe(4);
    expect(regSheet.getRow(2).getCell(5).value).toBe('P');
    const regPdf = await as(ctx.app, c.profTokens).get(`/v1/reports/offerings/${c.offering.id}/register/export?format=pdf`);
    expect(regPdf.statusCode).toBe(200);
    expect(regPdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('is empty, not an error, before any term or attendance exists', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const summary = expectStatus(await as(ctx.app, admin).get('/v1/reports/summary'), 200);
    expect(summary).toMatchObject({ term: null, sessions: 0, students: { total: 0, below: 0 }, trend: [] });
    expect(expectStatus(await as(ctx.app, admin).get('/v1/reports/students'), 200)).toMatchObject({ items: [], total: 0 });
  });
});

describe('report totals stay in step with the records', () => {
  const summary = async (tokens: Tokens, query = '') => expectStatus(await as(ctx.app, tokens).get(`/v1/reports/summary${query}`), 200);

  it('after a mark is changed by hand, a session is re-opened or cancelled', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a1], status: 'present', reason: 'Was there' }), 200);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
    expect((await summary(c.admin)).overall).toMatchObject({ present: 1, total: 3 });

    // Corrected after the class.
    expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a2], status: 'present', reason: 'Late arrival' }), 200);
    expect((await summary(c.admin)).overall).toMatchObject({ present: 2, total: 3 });

    // Re-opened: not counted until it finishes again.
    expectStatus(await prof.post(`/v1/sessions/${session.id}/extend`, { minutes: 5 }), 200);
    expect((await summary(c.admin)).overall.total).toBe(0);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
    expect((await summary(c.admin)).overall.total).toBe(3);

    expectStatus(await prof.post(`/v1/sessions/${session.id}/cancel`, { reason: 'Wrong class' }), 200);
    expect((await summary(c.admin)).sessions).toBe(0);
  });

  it('counts a session as soon as its time is up, before the sweeper closes it', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    expectStatus(await as(ctx.app, c.profTokens).post('/v1/sessions', { offeringId: c.offering.id }), 201);
    expect((await summary(c.admin)).sessions).toBe(0);
    ctx.advance(11 * 60_000);
    expect((await summary(c.admin)).sessions).toBe(1);
    expect((await expectStatus(await as(ctx.app, c.admin).get('/v1/reports/students'), 200)).total).toBe(3);
  });

  it('regroups trends when a student moves to another class', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
    expect((await summary(c.admin, `?unitId=${c.s.compB}`)).sessions).toBe(0);

    expectStatus(await as(ctx.app, c.admin).patch(`/v1/students/${c.students.a3}`, { unitId: c.s.compB }), 200);
    const divB = await summary(c.admin, `?unitId=${c.s.compB}`);
    expect(divB.sessions).toBe(1);
    expect(divB.students.total).toBe(1);
  });

  it('works out batch trends from the records themselves', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a1], status: 'present', reason: 'Was there' }), 200);
    expectStatus(await prof.post(`/v1/sessions/${session.id}/close`), 200);
    const a1 = await summary(c.admin, `?groupId=${c.s.a1}`);
    expect(a1.trend).toEqual([expect.objectContaining({ sessions: 1, percentage: 50 })]);
    expect(a1.students.total).toBe(2);
  });
});
