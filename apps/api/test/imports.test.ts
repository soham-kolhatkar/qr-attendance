import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  as,
  createUserAs,
  expectStatus,
  login,
  multipartFile,
  setupInstitute,
  setupStructure,
  type Tokens,
  useTestApp,
} from './helpers.js';

const ctx = useTestApp();

async function upload(tokens: Tokens, kind: 'students' | 'staff', csv: string | Buffer, query = '', filename = 'data.csv') {
  const { payload, headers } = multipartFile(filename, csv);
  return ctx.app.inject({
    method: 'POST',
    url: `/v1/imports/${kind}${query ? `?${query}` : ''}`,
    payload,
    headers: { ...headers, authorization: `Bearer ${tokens.accessToken}` },
  });
}

async function setupLevels(admin: Tokens) {
  const api = as(ctx.app, admin);
  for (const name of ['Department', 'Year', 'Division']) expectStatus(await api.post('/v1/structure/levels', { name }), 201);
}

const STUDENTS_CSV = [
  'Enrollment No,Name,Email,Roll No,Department,Year,Division,Batch',
  '2024COMP001,Aarav Patil,aarav@example.com,1,Computer Engineering,SY,Div A,A1',
  '2024COMP002,Diya Deshmukh,,2,Computer Engineering,SY,Div A,A2',
  '2024COMP051,Rohan Shinde,,1,Computer Engineering,SY,Div B,',
  '2024MECH001,Neha Kale,,1,Mechanical Engineering,SY,Div A,"A1, Workshop"',
].join('\n');

describe('student import', () => {
  it('previews without saving anything', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupLevels(admin);
    const report = expectStatus(await upload(admin, 'students', STUDENTS_CSV), 200);
    expect(report).toMatchObject({ dryRun: true, summary: { rows: 4, create: 4, update: 0, unchanged: 0, errors: 0 } });
    expect(report.newUnits).toEqual([
      'Computer Engineering',
      'Computer Engineering › SY',
      'Computer Engineering › SY › Div A',
      'Computer Engineering › SY › Div B',
      'Mechanical Engineering',
      'Mechanical Engineering › SY',
      'Mechanical Engineering › SY › Div A',
    ]);
    // Same batch name in two departments → two different groups.
    expect(report.newGroups).toEqual([
      'A1 (Computer Engineering › SY › Div A)',
      'A2 (Computer Engineering › SY › Div A)',
      'A1 (Mechanical Engineering › SY › Div A)',
      'Workshop (Mechanical Engineering › SY › Div A)',
    ]);
    expect(report.credentials).toBeUndefined();
    expect(expectStatus(await as(ctx.app, admin).get('/v1/structure'), 200).units).toEqual([]);
  });

  it('saves on commit and returns one-time credentials that work', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupLevels(admin);
    const report = expectStatus(await upload(admin, 'students', STUDENTS_CSV, 'dryRun=false'), 200);
    expect(report.summary.create).toBe(4);
    expect(report.credentials).toHaveLength(4);

    const aarav = report.credentials.find((c: { username: string }) => c.username === '2024comp001');
    const tokens = await login(ctx.app, { instituteCode: 'ALPHA', username: '2024comp001', password: aarav.temporaryPassword });
    const me = expectStatus(await as(ctx.app, tokens).get('/v1/me'), 200);
    expect(me.user).toMatchObject({ fullName: 'Aarav Patil', email: 'aarav@example.com', mustChangePassword: true });
    expect(me.student).toMatchObject({ rollNo: '1', unitPath: ['Computer Engineering', 'SY', 'Div A'], groups: [{ name: 'A1' }] });

    const neha = expectStatus(await as(ctx.app, admin).get('/v1/students?q=neha'), 200).items[0];
    expect(neha.groups.map((g: { name: string }) => g.name)).toEqual(['A1', 'Workshop']);
  });

  it('is idempotent: importing the same file again changes nothing', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupLevels(admin);
    expectStatus(await upload(admin, 'students', STUDENTS_CSV, 'dryRun=false'), 200);
    const again = expectStatus(await upload(admin, 'students', STUDENTS_CSV, 'dryRun=false'), 200);
    expect(again.summary).toMatchObject({ create: 0, update: 0, unchanged: 4 });
    expect(again.newUnits).toEqual([]);
    expect(again.credentials).toEqual([]);
  });

  it('updates existing students; blank cells keep existing data', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupLevels(admin);
    expectStatus(await upload(admin, 'students', STUDENTS_CSV, 'dryRun=false'), 200);

    const changes = [
      'Username,Full Name,Email,Roll No,Department,Year,Division',
      // Moves to Div B with a new roll number; email blank → kept; A1 batch dropped (not valid in Div B).
      '2024comp001,Aarav Patil,,31,Computer Engineering,SY,Div B',
    ].join('\n');
    const report = expectStatus(await upload(admin, 'students', changes, 'dryRun=false'), 200);
    expect(report.summary).toMatchObject({ create: 0, update: 1 });

    const aarav = expectStatus(await as(ctx.app, admin).get('/v1/students?q=aarav'), 200).items[0];
    expect(aarav).toMatchObject({ email: 'aarav@example.com', rollNo: '31', unitPath: ['Computer Engineering', 'SY', 'Div B'], groups: [] });
  });

  it('matches existing classes and groups case-insensitively', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const s = await setupStructure(ctx.app, admin);
    const csv = ['Username,Full Name,Department,Year,Division,Groups', 'stu1,Asha,computer engineering, sy ,DIV A,a1'].join('\n');
    const report = expectStatus(await upload(admin, 'students', csv, 'dryRun=false'), 200);
    expect(report.newUnits).toEqual([]);
    expect(report.newGroups).toEqual([]);
    const asha = expectStatus(await as(ctx.app, admin).get(`/v1/students?groupId=${s.a1}`), 200).items;
    expect(asha.map((x: { username: string }) => x.username)).toEqual(['stu1']);
  });

  it('reports every row problem with its row number, and a failing commit saves nothing', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupLevels(admin);
    await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
    const csv = [
      'Username,Full Name,Email,Department,Year,Division',
      'ok1,Fine Student,,Computer Engineering,SY,Div A', // row 2
      'x,Bad Username,,Computer Engineering,SY,Div A', // row 3
      'ok2,Bad Email,not-an-email,Computer Engineering,SY,Div A', // row 4
      'ok3,Gap In Levels,,Computer Engineering,,Div A', // row 5
      'ok1,Duplicate,,Computer Engineering,SY,Div A', // row 6
      'prof.a,A Teacher,,Computer Engineering,SY,Div A', // row 7
      'ok4,No Class,,,,', // row 8
      ',No Username,,Computer Engineering,SY,Div A', // row 9
    ].join('\n');

    const preview = expectStatus(await upload(admin, 'students', csv), 200);
    expect(preview.summary).toMatchObject({ rows: 8, create: 1, errors: 7 });
    expect(preview.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(preview.errors.find((e: { row: number }) => e.row === 6).message).toContain('row 2');
    expect(preview.errors.find((e: { row: number }) => e.row === 5).message).toContain('Fill in "Year"');

    const commit = await upload(admin, 'students', csv, 'dryRun=false');
    expect(commit.statusCode).toBe(422);
    expect(commit.json().error).toMatchObject({ code: 'IMPORT_HAS_ERRORS', details: { summary: { errors: 7 } } });
    expect(expectStatus(await as(ctx.app, admin).get('/v1/students'), 200).total).toBe(0);
  });

  it('with createMissing=false, unknown classes are errors instead of new units', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupStructure(ctx.app, admin);
    const csv = ['Username,Full Name,Department,Year,Division,Batch', 'stu1,A,Computer Engineering,SY,Div C,', 'stu2,B,Computer Engineering,SY,Div A,A9'].join('\n');
    const report = expectStatus(await upload(admin, 'students', csv, 'createMissing=false'), 200);
    expect(report.errors).toEqual([
      { row: 2, column: 'Division', message: 'Division "Div C" does not exist under "Computer Engineering › SY"' },
      { row: 3, column: 'groups', message: 'Group "A9" does not exist for this class' },
    ]);
  });

  it('rejects files missing required columns or structure levels', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const noLevels = await upload(admin, 'students', 'Username,Full Name\nstu1,A');
    expect(noLevels.json().error.code).toBe('NO_LEVELS');
    await setupLevels(admin);
    const res = await upload(admin, 'students', 'Username,Department\nstu1,COMP');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'MISSING_COLUMNS', message: expect.stringContaining('Full Name') });
  });

  it('reads .xlsx files, including numeric and hyperlink cells', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupLevels(admin);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Students');
    sheet.addRow(['Username', 'Full Name', 'Email', 'Phone', 'Department', 'Year', 'Division']);
    const row = sheet.addRow(['2024comp001', 'Aarav Patil', null, 9876543210, 'Computer Engineering', 'SY', 'Div A']);
    row.getCell(3).value = { text: 'aarav@example.com', hyperlink: 'mailto:aarav@example.com' };
    const file = Buffer.from(await workbook.xlsx.writeBuffer());

    const report = expectStatus(await upload(admin, 'students', file, 'dryRun=false', 'students.xlsx'), 200);
    expect(report.summary.create).toBe(1);
    const student = expectStatus(await as(ctx.app, admin).get('/v1/students'), 200).items[0];
    expect(student).toMatchObject({ email: 'aarav@example.com', phone: '9876543210' });
  });

  it('serves a template whose columns follow the institute structure', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupLevels(admin);
    const res = await as(ctx.app, admin).get('/v1/imports/students/template');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const headers = (workbook.worksheets[0]!.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(['Username', 'Full Name', 'Email', 'Phone', 'Roll No', 'Department', 'Year', 'Division', 'Groups']);
  });

  it('is admin-only', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await createUserAs(ctx.app, admin, { role: 'faculty', username: 'prof.a' });
    const faculty = await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.a' });
    expect((await upload(faculty, 'students', STUDENTS_CSV)).statusCode).toBe(403);
  });
});

describe('staff import', () => {
  it('creates faculty and HODs with their departments', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    const s = await setupStructure(ctx.app, admin);
    const csv = [
      'Employee ID,Name,Email,Role,Designation,Department',
      'EMP001,Dr. Kulkarni,,HOD,Head of Department,Computer Engineering',
      'EMP002,Prof. Sharma,sharma@example.com,,Assistant Professor,Computer Engineering',
      'EMP003,Prof. Rao,,faculty,,',
    ].join('\n');
    const report = expectStatus(await upload(admin, 'staff', csv, 'dryRun=false'), 200);
    expect(report.summary).toMatchObject({ create: 3, errors: 0 });
    expect(report.newUnits).toEqual([]);

    const staff = expectStatus(await as(ctx.app, admin).get('/v1/users?q=emp'), 200).items;
    const byName = Object.fromEntries(staff.map((u: { username: string }) => [u.username, u]));
    expect(byName.emp001).toMatchObject({ role: 'hod', unitId: s.comp, designation: 'Head of Department' });
    expect(byName.emp002).toMatchObject({ role: 'faculty', unitId: s.comp, email: 'sharma@example.com' });
    expect(byName.emp003).toMatchObject({ role: 'faculty', unitId: null });
  });

  it('requires a department for HODs and never changes existing roles', async () => {
    const { admin } = await setupInstitute(ctx.app, ctx.db);
    await setupStructure(ctx.app, admin);
    await createUserAs(ctx.app, admin, { role: 'faculty', username: 'emp010' });
    await createUserAs(ctx.app, admin, { role: 'student', username: 'stu1' });
    const csv = ['Username,Full Name,Role,Department', 'emp001,A,hod,', 'emp010,B,admin,', 'stu1,C,faculty,', 'emp002,D,principal,'].join('\n');
    const report = expectStatus(await upload(admin, 'staff', csv), 200);
    expect(report.errors.map((e: { row: number; column?: string }) => [e.row, e.column])).toEqual([
      [2, 'Department'],
      [3, 'role'],
      [4, 'username'],
      [5, 'role'],
    ]);
  });
});
