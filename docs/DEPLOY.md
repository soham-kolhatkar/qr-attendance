# Deploying to Render (free test environment)

This puts the whole product online at one HTTPS address. Browsers and, later, the
student phone app use that address. It runs on Render's free plan: good for testing,
**not for a real institute** (see the limits below).

| Piece | Where | Plan |
|---|---|---|
| `qr-attendance`: the API (`/v1`, `/docs`) **and** the web app (all other pages) | Render web service, from [`render.yaml`](../render.yaml) | Free, Singapore |
| PostgreSQL database | [Neon](https://neon.com) | Free; doesn't expire |

On every start the service applies database migrations and makes sure your platform
owner account exists. Free services have no shell, so this is automatic.

## The database (Neon)

1. In the Neon console, open your project → **Connect**.
2. **Turn off "Connection pooling".** Copy the **direct** connection string, whose host has
   **no `-pooler`**, because live attendance updates need a direct connection. You can
   also take the pooled string and delete `-pooler` from the host. It looks like:
   `postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/DBNAME?sslmode=require&channel_binding=require`
3. Treat it like a password. It goes into Render (below) and optionally a local
   `apps/api/.env.neon` file (ignored by git). It never goes into the repository or a chat.
4. **Region:** the part after `ep-xxxx.` shows where the database lives. Ideally it is
   `ap-southeast-1` (Singapore), next to the Render service. Every scan makes a few
   database round trips, so a database on another continent adds noticeable delay. If the
   project is elsewhere, creating a new Neon project in Singapore is quickest while it's
   still empty.
5. **Optional check from your laptop** (read-only, changes nothing). Put the line
   `DATABASE_URL=<the string>` into `apps/api/.env.neon`, then:
   ```bash
   cd apps/api && npx tsx --env-file=.env.neon src/db/check.ts
   ```
   It should show ✔ for connected, encrypted (TLS), and live updates.

## One-time setup (about 15 minutes)

1. **Code on GitHub.** The repository is `github.com/soham-kolhatkar/qr-attendance`.
   Render deploys whatever is on the `master` branch.
2. **Create a Render account** at <https://render.com>. "Sign up with GitHub" is easiest.
   Free resources don't need a payment card.
3. In Render: **New → Blueprint** → connect GitHub → choose the `qr-attendance` repository.
   Render reads `render.yaml` and shows one web service.
4. It asks for two secrets:
   - **`DATABASE_URL`**: the Neon direct connection string from above.
   - **`SEED_PLATFORM_ADMIN_PASSWORD`**: your platform-owner password. Use a strong one
     with at least 12 characters and keep it somewhere safe.
5. Click **Apply**. The first build and start take roughly 5–10 minutes. Watch the
   service's **Logs** tab. Ready looks like:
   ```
   Migrations applied.
   Created platform admin "owner".
   Seeded DEMO structure. ...
   ```
6. Open the service's address, shown at the top of its page, usually
   `https://qr-attendance.onrender.com` (Render adds a suffix if the name is taken).

## Signing in

- **You (platform owner):** on the sign-in page click *Platform owner sign-in*. The
  username is `owner`, with the password from step 4. From there you can onboard real
  institutes.
- **Demo institute** (because `SEED_DEMO=true`): institute code `DEMO`, password
  `demo-pass-123`, with users `admin`, `hod.comp`, `prof.sharma` and `2024comp001`…`004`,
  `2024comp051`…`052`.
- **API docs:** `<your address>/docs`.

## Updating

Every push to `master` is checked first: GitHub runs every test (server, web app with a
real browser, phone app types) and a security audit of the packages the server uses,
about 6 minutes. Render deploys the push **only when all of that passes**
(`autoDeployTrigger: checksPass` in `render.yaml`), so a broken change never reaches the
site. Data in the database is kept across deploys.

To see a check: GitHub → the repository → *Actions*. A red cross means the push wasn't
deployed; the run says which test failed, and *browser-tests* holds its screenshots.

## The student app and this server

Phones prove they run the genuine student app, signed with the app's release key. The
server checks that against `ANDROID_SIGNING_CERT_SHA256` in `render.yaml` (a public
fingerprint, not a secret; the app build prints it). If the app is ever signed with a
different key — for example by Google Play — add that key's fingerprint, comma-separated.

The app talks to this address by default. Students sign in with the same institute code,
username and password as on the web.

## Email and phone notifications (optional)

Without these, every notification still appears in the notification list (the bell) on
the web and in the app. Each one is a free account and a few settings; do them in any order.

**Email (Brevo, free: 300 emails a day).**
1. Create an account at brevo.com.
2. *Senders, domains & dedicated IPs → Senders → Add a sender*: the address emails come
   from, e.g. one of your own. Brevo emails it a confirmation link; click it.
3. *SMTP & API → API keys → Generate a new API key*. Copy it (it is shown once).
4. Render → service → *Environment*, add:
   - `EMAIL_PROVIDER` = `brevo`
   - `BREVO_API_KEY` = the key
   - `EMAIL_FROM` = `QR Attendance <the sender address>`

   then *Save, rebuild and deploy*.

Emails from a free address (Gmail and the like) sent through Brevo may land in spam. A
real institute should send from its own domain, set up under *Senders, domains* in Brevo.
Emails over the daily limit wait for the next day (`EMAIL_DAILY_LIMIT`, default 300).

**Phone notifications (Firebase Cloud Messaging, free).**
1. At console.firebase.google.com, *Create a project* (Google Analytics isn't needed).
2. *Add app → Android*, package name `com.qrattendance.student`. Download
   `google-services.json` and save it as `~/.qr-attendance/google-services.json` on the
   computer that builds the app (next to the signing key; keep it out of the repository).
3. Rebuild the app (`npm run build:android`; it says "push notifications: on") and
   install it on the phones.
4. *Project settings → Service accounts → Generate new private key* downloads a JSON
   file. It is a secret: in Render → service → *Environment*, add `FCM_SERVICE_ACCOUNT`
   and paste the whole file's contents as the value. *Save, rebuild and deploy*.

The admin *Settings* page says which of the two are set up. Reminders go out from 5 pm
(India time) and the staff summary on Monday mornings; the free plan sleeps when idle, so
they go out the next time the server is awake.

## Connecting an institute's own systems

Admins create API keys and webhooks on the *Integrations* page; their developers read
`<your address>/docs/integration`. Nothing needs setting up on Render. Webhooks only go
to public HTTPS addresses (`WEBHOOK_ALLOW_PRIVATE_URLS` must stay unset here). To try a
webhook without a system of your own, use an address from a request-inspection site such
as webhook.site and press *Send test*.

## Checking a deployment

A smoke test runs the core path against the live site with a real browser:
1. A teacher starts a session and opens the projector.
2. The test reads the QR code from the screen and submits it as an absent student. A scan
   needs the student's linked phone, so the server refuses it with "phone required" —
   which also proves the code was valid — and the test marks the student by hand instead.
3. Both screens update live, and the code rotates.

It works with existing data, using the DEMO institute (so `SEED_DEMO=true`), and adds at
most one closed session:

```bash
cd apps/web && E2E_BASE_URL=https://<your-app>.onrender.com npx playwright test smoke.spec.ts
```

## Limits of the free plan: read before using it in a class

- **It falls asleep.** After 15 minutes without visits the service sleeps, and the next
  visit takes about **1 minute** to wake it. Teachers should open the web app a minute
  before class. A paid instance never sleeps.
- **The database pauses too.** Neon suspends after 5 idle minutes and resumes in about a
  second on the next query. You won't notice it next to Render's wake-up.
- **Neon free allowances:** 0.5 GB storage, 100 compute-hours a month (a small database
  running about 400 hours), 5 GB transfer a month, and 6 hours of point-in-time recovery.
  Each attendance mark takes about 440 bytes, so 0.5 GB holds roughly one term for 4,000
  students; the System page shows the size. Going over a limit doesn't delete data.
- **Render free allowances:** 750 running hours a month (enough for one service all
  month), plus limited bandwidth and build minutes. Render suspends free services that
  run out until the next month.
- **The demo passwords are public.** Anyone who finds the address can sign in to the
  DEMO institute. It only holds made-up data. Before a real institute uses this
  deployment, set `SEED_DEMO` to `false` (Render → service → Environment).

**For a real institute:** move the Render service to a paid instance (no sleeping), move
Neon to a paid plan (longer recovery history, more compute), and turn the demo off. How
big an instance: see *How much server is needed* below.

## How much server is needed

Measured with `apps/api/scripts/load-test.ts`: every class starts at the same moment and
its students scan within 90 seconds, most of them in the first half minute (harsher than
real life). Each student's app also reloads their attendance, three admins refresh the
dashboard every 10 seconds, and every teacher has the live screen open. The server ran with
the CPU of each Render plan; the database was local. Times are how long students wait for
"present".

| Render plan (CPU) | 30 classes × 66 students (≈2,000 scans) | 30 classes × 334 students (≈10,000 scans) |
|---|---|---|
| Free (0.1) | Overloaded: waits of 25 s or more, a quarter of the codes expire before they arrive | — |
| Starter, $7/month (0.5) | Typical 0.01 s; 95% within 0.6 s; nothing lost | Overloaded: waits of several seconds, a few codes expire |
| Standard, $25/month (1) | — | Typical 0.01 s; 95% within 2.6 s; all 10,020 recorded |

So: the free plan is for trying the product with a class or two. A college whose busiest
period has up to ~2,000 students scanning at once runs well on **Starter**. For more,
use **Standard**, or two Starter instances (Render → service → *Scaling*): the server
keeps nothing to itself, so instances share the work, including the live screens.

With a hosted database each request also waits about a millisecond per query for the
network, so expect a little more; the database plan matters too (Neon's free compute is
small; a paid plan lets it grow under load).

## Backups

Three layers, from quickest to most independent:

1. **Neon's point-in-time recovery:** back to any moment in the last 6 hours (free plan;
   7–30 days on paid plans), in Neon's console. For "someone deleted the wrong thing an
   hour ago".
2. **Nightly encrypted backups on GitHub:** at 2 am India time, *Actions → Database backup*
   copies the whole database, restores the copy into a scratch database to prove it works,
   encrypts it and keeps it for 30 days. The repository is public, so the file is
   encrypted for a key that only you have: `~/.qr-attendance/backup-key.txt`.
3. **Your own copy of `~/.qr-attendance`**, which holds that key, the app's signing key and
   the Firebase file. Keep it in a password manager or on a USB drive as well as on this
   computer: without it the backups can't be opened and the app can't be updated.

**One-time setup:** GitHub → the repository → *Settings → Secrets and variables → Actions →
New repository secret*: name `BACKUP_DATABASE_URL`, value Neon's direct connection string
(the same as Render's `DATABASE_URL`). Then *Actions → Database backup → Run workflow* once
to check: a green tick and a `database-backup-<date>` file on the run's page.

**Restoring** (into an empty database: a new Neon project or branch, or a local one):

```bash
# download and unzip the backup file from the workflow run's page, then:
scripts/restore-backup.sh qr-attendance-2026-10-18.dump.age 'postgres://…new empty database…'
```

It needs Docker and `age` (`~/opt/age/age` on this computer). Then point Render's
`DATABASE_URL` at the restored database. Practise this now and then: a backup is only as
good as the last time it was restored (the nightly job checks that part automatically).

## Monitoring

- **System page** (platform owner → *System*): whether the database and the background work
  (closing sessions, report totals, notifications, reminders, webhooks) are running, the
  database size, what's waiting to be sent, and the latest server errors.
- **Alert emails:** set `ALERT_EMAIL` on Render (your address; several separated by commas).
  Server errors and stalled background work are emailed there, at most once an hour.
  This needs email set up (Brevo) but not the database, so it also reports the database
  being down.
- **Uptime:** `<your address>/health` answers 200 when the server, its database and its
  background work are fine, and 503 with the problem otherwise. On a paid plan, point a
  free monitor such as UptimeRobot at it (every 5 minutes) to be emailed when the whole
  site is down. Not on the free plan: the checks would keep the service and the database
  awake all month and use up Neon's free compute hours.
- **Logs:** Render → service → *Logs*: one line per request (method, path, status, time),
  slow requests (over 2 s) as warnings, errors in full.

## If something goes wrong

| Symptom in Logs | Fix |
|---|---|
| `SEED_PLATFORM_ADMIN_PASSWORD must be at least 12 characters` | Render → service → Environment → set a longer password → *Save, rebuild and deploy* |
| `Invalid environment configuration` | A variable from `render.yaml` is missing; re-sync the Blueprint |
| `password authentication failed` / `ENOTFOUND` | `DATABASE_URL` is wrong; copy it again from Neon (Render → service → Environment) |
| `Live updates need a direct database connection` | The Neon URL is the pooled one; use the direct one (no `-pooler`) |
| The laptop check says `could not reach the database (ETIMEDOUT)` | Your network blocks database port 5432 (common on office networks). Render is not affected; to check from the laptop, use another network such as a phone hotspot |
| Page says the service is waking up | Normal after 15 idle minutes; wait about a minute |
| A push didn't deploy | Its checks failed: GitHub → *Actions* says which test. Fix and push again |
| *Database backup* failed: "Add the BACKUP_DATABASE_URL secret" | See *Backups*, one-time setup |
| *Database backup* failed: "pg_dump failed: … password authentication failed" or "… could not translate host name" | The secret's value is wrong: paste Neon's connection string again (GitHub → Settings → Secrets → `BACKUP_DATABASE_URL` → Update) |
| Render's *Events* say the health check failed | The System page (or `/health`) names the problem: database unreachable, or background work stalled |
| `Invalid environment configuration` mentioning `FCM_SERVICE_ACCOUNT` | Paste the Firebase key file's whole contents, starting with `{` |
| `notification delivery problem` … `Brevo 401` | `BREVO_API_KEY` is wrong or was deleted in Brevo |
| `notification delivery problem` … `Brevo 400` … sender | `EMAIL_FROM` isn't a sender verified in Brevo |

Changing `SEED_PLATFORM_ADMIN_PASSWORD` later does **not** change an existing owner's
password. Sign in and use *Change password* instead.

## Rehearsing locally

The same build and start, without Render:

```bash
NODE_ENV=production npm ci --include=dev
npm run build -w apps/api && npm run build -w apps/web
NODE_ENV=production SERVE_WEB=true TRUST_PROXY=true PORT=10000 \
  DATABASE_URL=postgres://qra:qra@localhost:55432/<empty database> JWT_SECRET=<32+ random chars> \
  SEED_PLATFORM_ADMIN_USERNAME=owner SEED_PLATFORM_ADMIN_PASSWORD=<12+ chars> SEED_DEMO=true \
  npm run start:prod -w apps/api
```

Then run the browser tests against it:
`E2E_BASE_URL=http://localhost:10000 E2E_OWNER_PASSWORD=<owner password> npm run e2e`
(on a freshly seeded database).
