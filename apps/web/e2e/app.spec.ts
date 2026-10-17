import { expect, type Page, test } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

/**
 * Walks through the product the way people use it, against the DEMO institute:
 * admin screens, a teacher running attendance with the projector open, a student
 * "phone" scanning the projected code, manual marking and closing.
 * Screenshots go to e2e/screenshots for review.
 */

/** API address: the deployment itself when testing one (same origin), else the local test API. */
const API = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const PASSWORD = 'demo-pass-123';
/** Full-page screenshot once open/close animations have settled. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
}

async function signIn(page: Page, username: string, password = PASSWORD, instituteCode: string | null = 'DEMO') {
  await page.goto('/login');
  if (instituteCode === null) {
    await page.getByText('Platform owner sign-in').click();
  } else {
    await page.getByLabel('Institute code').fill(instituteCode);
  }
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Reads the QR code the way a phone camera would: from the pixels on screen. */
async function decodeQr(page: Page): Promise<string | null> {
  const png = PNG.sync.read(await page.getByTestId('projector-qr').screenshot());
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
}

test.describe.configure({ mode: 'serial' });

test('sign-in page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, 'admin', 'wrong-password');
  await expect(page.getByText('Invalid institute code, username or password')).toBeVisible();
  await shot(page, '01-login');
});

test('admin screens', async ({ page }) => {
  await signIn(page, 'admin');
  await expect(page.getByText('Welcome, Demo Admin')).toBeVisible();
  await expect(page.getByText('Teachers & HODs')).toBeVisible();
  await expect(page.getByText('Getting started')).toBeVisible();
  await shot(page, '02-admin-home');

  await page.getByRole('link', { name: 'Structure' }).click();
  await expect(page.getByRole('heading', { name: 'Structure', exact: true })).toBeVisible();
  await expect(page.getByText('Computer Engineering')).toBeVisible();
  await expect(page.getByText('Div A')).toBeVisible();
  await shot(page, '03-structure');

  await page.getByRole('link', { name: 'Students' }).click();
  await expect(page.getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Aarav Patil' })).toBeVisible();
  await page.getByRole('cell', { name: 'Aarav Patil' }).click();
  await expect(page.getByRole('dialog').getByText('Username')).toBeVisible();
  await shot(page, '04-student-drawer');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Batches & groups' }).click();
  await expect(page.getByRole('heading', { name: 'Batches & groups', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'A1', exact: true })).toBeVisible();
  await shot(page, '05-groups');

  await page.getByRole('link', { name: 'Offerings' }).click();
  await expect(page.getByRole('heading', { name: 'Offerings', exact: true })).toBeVisible();
  await expect(page.getByText('Data Structures')).toBeVisible();
  await shot(page, '06-offerings');

  await page.getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Prof. Sharma' })).toBeVisible();
  await shot(page, '07-staff');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByLabel('QR code changes every (seconds)')).toHaveValue('5');
  await shot(page, '08-settings');
});

test('admin imports students from a spreadsheet', async ({ page }) => {
  await signIn(page, 'admin');
  await page.getByRole('link', { name: 'Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import from Excel', exact: true })).toBeVisible();
  const csv = [
    'Enrollment No,Name,Roll No,Department,Year,Division,Batch',
    '2024COMP005,Isha Kulkarni,5,Computer Engineering,SY,Div A,A2',
    '2024COMP006,Nikhil Jadhav,6,Computer Engineering,SY,Div A,A1',
    '2024COMP007,Typo Student,7,Computer Engg,SY,Div A,',
  ].join('\n');
  await page.locator('button:has-text("Choose .xlsx or .csv")').click();
  await page.locator('input[type=file]').setInputFiles({ name: 'students.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('3 new classes will be created')).toBeVisible();
  await expect(page.getByText('Computer Engg › SY › Div A', { exact: true })).toBeVisible();
  await shot(page, '09-import-preview');

  // Fix the typo: upload the corrected file.
  await page.locator('input[type=file]').setInputFiles({ name: 'students.csv', mimeType: 'text/csv', buffer: Buffer.from(csv.replace('Computer Engg,', 'Computer Engineering,')) });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByRole('button', { name: 'Import 3 students' })).toBeEnabled();
  await page.getByRole('button', { name: 'Import 3 students' }).click();
  await expect(page.getByText('Import complete')).toBeVisible();
  await expect(page.getByText('Save the temporary passwords now')).toBeVisible();
  await shot(page, '10-import-done');
});

test('teacher runs attendance; a student scans the projected code', async ({ page, context, request }) => {
  await signIn(page, 'prof.sharma');
  await expect(page).toHaveURL(/\/classes/);
  await expect(page.getByText('CS301')).toBeVisible();
  await shot(page, '11-my-classes');

  // Start a lecture for CS301 (SY Div A).
  const card = page.locator('.mantine-Card-root', { hasText: 'CS301' });
  await card.getByRole('button', { name: 'Take attendance' }).click();
  await page.getByLabel('Topic (optional)').fill('Stacks and queues');
  await shot(page, '12-start-session');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]+$/);
  await expect(page.getByText('Scanning open')).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const sessionUrl = page.url();

  // The projector, in its own window.
  const projector = await context.newPage();
  await projector.goto(`${sessionUrl}/projector`);
  await expect(projector.getByTestId('projector-qr')).toBeVisible();
  // 4 seeded + 3 imported students in SY Div A.
  await expect(projector.getByText('0 / 7')).toBeVisible();

  // A phone camera reads the projected code...
  const scanned = await decodeQr(projector);
  expect(scanned).toMatch(/^QA1\./);
  expect(scanned).toBe(await projector.getByTestId('projector-qr').getAttribute('data-payload'));
  await projector.screenshot({ path: 'e2e/screenshots/13-projector.png' });

  // ...and the student's app submits it.
  const studentLogin = await request.post(`${API}/v1/auth/login`, {
    data: { instituteCode: 'DEMO', username: '2024comp001', password: PASSWORD },
  });
  const { accessToken } = await studentLogin.json();
  const scan = await request.post(`${API}/v1/attendance/scan`, {
    headers: { authorization: `Bearer ${accessToken}` },
    data: { qr: scanned },
  });
  expect(scan.status()).toBe(200);
  expect((await scan.json()).session.subject.code).toBe('CS301');

  // Both screens update live.
  await expect(projector.getByText('1 / 7')).toBeVisible();
  await expect(page.getByText('Aarav Patil').first()).toBeVisible();
  await expect(page.getByRole('row', { name: /Aarav Patil/ }).getByText('present')).toBeVisible();

  // The code rotates: a later frame decodes to a different, still valid code.
  await projector.waitForTimeout(5200);
  const later = await decodeQr(projector);
  expect(later).toMatch(/^QA1\./);
  expect(later).not.toBe(scanned);

  // Teacher marks a student without a phone by hand.
  await page.getByRole('row', { name: /Diya Deshmukh/ }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('dialog').getByText('No phone').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark present' }).click();
  await expect(page.getByRole('row', { name: /Diya Deshmukh/ }).getByText('present')).toBeVisible();
  await expect(projector.getByText('2 / 7')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shot(page, '14-session-live');

  // Close scanning: the projector says so.
  await page.getByRole('button', { name: 'Close scanning' }).click();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await expect(projector.getByText('Attendance closed')).toBeVisible();
  await projector.screenshot({ path: 'e2e/screenshots/15-projector-closed.png' });

  await page.getByRole('link', { name: 'Sessions' }).click();
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
  await expect(page.getByText('2/7')).toBeVisible();
  await shot(page, '16-sessions');
  await signOut(page);
});

test('HOD sees their department', async ({ page }) => {
  await signIn(page, 'hod.comp');
  await expect(page).toHaveURL(/\/classes/);
  await page.getByRole('link', { name: 'Students' }).click();
  await expect(page.getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Aarav Patil' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add student' })).toHaveCount(0);
  await shot(page, '17-hod-students');
});

test('student and platform owner', async ({ page }) => {
  await signIn(page, '2024comp002');
  await expect(page).toHaveURL(/\/profile/);
  await expect(page.getByText('Computer Engineering › SY › Div A')).toBeVisible();
  await shot(page, '18-student-profile');
  await signOut(page);

  await signIn(page, 'owner', process.env.E2E_OWNER_PASSWORD ?? 'owner-pass-123', null);
  await expect(page).toHaveURL(/\/platform\/institutes/);
  await expect(page.getByRole('cell', { name: 'Demo Institute of Technology' })).toBeVisible();
  await shot(page, '19-platform-institutes');
});

test('new account must choose a password first', async ({ page, request }) => {
  const admin = await (
    await request.post(`${API}/v1/auth/login`, { data: { instituteCode: 'DEMO', username: 'admin', password: PASSWORD } })
  ).json();
  const created = await (
    await request.post(`${API}/v1/users/`, {
      headers: { authorization: `Bearer ${admin.accessToken}` },
      data: { role: 'faculty', username: 'prof.new', fullName: 'Prof. New' },
    })
  ).json();
  await signIn(page, 'prof.new', created.temporaryPassword);
  await expect(page).toHaveURL(/\/change-password/);
  await expect(page.getByText('Choose your password')).toBeVisible();
  await page.getByLabel('Temporary password', { exact: true }).fill(created.temporaryPassword);
  await page.getByLabel('New password', { exact: true }).fill('my-own-password-1');
  await page.getByLabel('Repeat new password', { exact: true }).fill('my-own-password-1');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page).toHaveURL(/\/classes/);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('teacher can follow a session from their phone', async ({ page }) => {
    await signIn(page, 'prof.sharma');
    await expect(page.getByRole('heading', { name: 'My classes' })).toBeVisible();
    await shot(page, '20-phone-my-classes');
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('link', { name: 'Sessions' }).click();
    await page.getByText('Stacks and queues').click();
    await expect(page.getByText('Class list')).toBeVisible();
    await expect(page.getByText('2 / 7').or(page.getByText('/ 7')).first()).toBeVisible();
    await shot(page, '21-phone-session');
  });
});
