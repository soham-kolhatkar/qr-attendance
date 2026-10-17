import { expect, type Page, test } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

/**
 * Deployment smoke test: the core attendance path against a live deployment that
 * already has data (unlike app.spec.ts, which needs a freshly seeded database).
 * Uses the DEMO institute (SEED_DEMO=true) and adds at most one session to it. A
 * scan needs a linked phone, so the student is marked by hand when one is required.
 *
 *   E2E_BASE_URL=https://<your-app>.onrender.com npx playwright test smoke.spec.ts
 */

const BASE = process.env.E2E_BASE_URL;
const PASSWORD = 'demo-pass-123';

test.skip(!BASE, 'Set E2E_BASE_URL to the deployment to check');

async function decodeQr(page: Page): Promise<string | null> {
  const png = PNG.sync.read(await page.getByTestId('projector-qr').screenshot());
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
}

test('a teacher takes attendance and a student scans, live on the deployment', async ({ page, context, request }) => {
  test.setTimeout(150_000);
  const api = async (path: string, token: string, init?: { method?: string; data?: unknown }) => {
    const res = await request.fetch(`${BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: { authorization: `Bearer ${token}` },
      data: init?.data,
    });
    return { status: res.status(), body: await res.json().catch(() => null) };
  };
  const token = async (username: string) =>
    (
      await (
        await request.post(`${BASE}/v1/auth/login`, { data: { instituteCode: 'DEMO', username, password: PASSWORD } })
      ).json()
    ).accessToken as string;

  // Free instances may be asleep; give them time to wake.
  await expect.poll(async () => (await request.get(`${BASE}/health`, { timeout: 90_000 })).status(), { timeout: 120_000 }).toBe(200);

  const teacher = await token('prof.sharma');
  const open = await api('/v1/sessions/?mine=true&status=open', teacher);
  let sessionId: string = open.body.items[0]?.id;
  const startedHere = !sessionId;

  await page.goto('/login');
  await page.getByLabel('Institute code').fill('DEMO');
  await page.getByLabel('Username').fill('prof.sharma');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My classes' })).toBeVisible();

  if (startedHere) {
    await page.locator('.mantine-Card-root', { hasText: 'CS301' }).getByRole('button', { name: 'Take attendance' }).click();
    await page.getByLabel('Topic (optional)').fill('Deployment check');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]+$/);
    sessionId = page.url().split('/').pop()!;
  } else {
    await page.goto(`/sessions/${sessionId}`);
  }
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });

  // Someone absent from this session will scan.
  const records = (await api(`/v1/sessions/${sessionId}/records`, teacher)).body as {
    username: string;
    fullName: string;
    status: string;
  }[];
  const absentee = records.find((r) => r.status === 'absent');
  test.skip(!absentee, 'Everyone in the open session is already marked');
  const before = (await api(`/v1/sessions/${sessionId}`, teacher)).body.counts;

  const projector = await context.newPage();
  await projector.goto(`/sessions/${sessionId}/projector`);
  await expect(projector.getByTestId('projector-qr')).toBeVisible({ timeout: 20_000 });
  await expect(projector.getByText(`${before.present} / ${before.total}`)).toBeVisible();

  const scanned = await decodeQr(projector);
  expect(scanned).toMatch(/^QA1\./);
  const studentToken = await token(absentee!.username);
  const t0 = Date.now();
  const scan = await api('/v1/attendance/scan', studentToken, { method: 'POST', data: { qr: scanned } });
  const scanMs = Date.now() - t0;
  // Scans must be signed by the student's linked phone, which this test doesn't have. The
  // server checks the code first, so "phone required" also proves the code was valid.
  const phoneRequired = scan.status === 403 && scan.body?.error?.code === 'DEVICE_REQUIRED';
  expect(phoneRequired || scan.status === 200, JSON.stringify(scan.body)).toBe(true);
  if (phoneRequired) {
    // Mark the student by hand instead, which travels the same live path.
    await page.getByRole('row', { name: new RegExp(absentee!.fullName) }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await page.getByRole('dialog').getByText('No phone').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Mark present' }).click();
  }

  // Live updates travel API → Postgres NOTIFY → server-sent events to both screens.
  await expect(projector.getByText(`${before.present + 1} / ${before.total}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('row', { name: new RegExp(absentee!.fullName) }).getByText('present')).toBeVisible({
    timeout: 10_000,
  });
  await projector.screenshot({ path: 'e2e/screenshots/live-projector.png' });

  await projector.waitForTimeout(5_500);
  const later = await decodeQr(projector);
  expect(later).toMatch(/^QA1\./);
  expect(later).not.toBe(scanned);

  if (startedHere) {
    await page.getByRole('button', { name: 'Close scanning' }).click();
    await expect(projector.getByText('Attendance closed')).toBeVisible({ timeout: 10_000 });
  }
  test.info().annotations.push({ type: 'scan round trip', description: `${scanMs} ms from this machine` });
  console.log(
    `scan round trip from this machine: ${scanMs} ms (${phoneRequired ? 'refused: phone required, marked by hand' : 'accepted'}); ` +
      `session ${startedHere ? 'started and closed by the test' : 'already open, left open'}`,
  );
});
