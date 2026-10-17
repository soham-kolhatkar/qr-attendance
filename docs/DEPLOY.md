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

Every push to `master` redeploys automatically. Data in the database is kept.

## Checking a deployment

A smoke test runs the core path against the live site with a real browser:
1. A teacher starts a session and opens the projector.
2. The test reads the QR code from the screen and an absent student scans it.
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
- **Neon free allowances:** 1 GB storage (plenty for testing; years of attendance for a
  small institute fit in well under that), 100 compute-hours a month, 5 GB transfer a
  month, and 6 hours of point-in-time recovery. Going over a limit doesn't delete data.
- **Render free allowances:** 750 running hours a month (enough for one service all
  month), plus limited bandwidth and build minutes. Render suspends free services that
  run out until the next month.
- **The demo passwords are public.** Anyone who finds the address can sign in to the
  DEMO institute. It only holds made-up data. Before a real institute uses this
  deployment, set `SEED_DEMO` to `false` (Render → service → Environment).

**For a real institute:** move the Render service to a paid instance (no sleeping), move
Neon to a paid plan (longer recovery history, more compute), and turn the demo off.

## If something goes wrong

| Symptom in Logs | Fix |
|---|---|
| `SEED_PLATFORM_ADMIN_PASSWORD must be at least 12 characters` | Render → service → Environment → set a longer password → *Save, rebuild and deploy* |
| `Invalid environment configuration` | A variable from `render.yaml` is missing; re-sync the Blueprint |
| `password authentication failed` / `ENOTFOUND` | `DATABASE_URL` is wrong; copy it again from Neon (Render → service → Environment) |
| `Live updates need a direct database connection` | The Neon URL is the pooled one; use the direct one (no `-pooler`) |
| The laptop check says `could not reach the database (ETIMEDOUT)` | Your network blocks database port 5432 (common on office networks). Render is not affected; to check from the laptop, use another network such as a phone hotspot |
| Page says the service is waking up | Normal after 15 idle minutes; wait about a minute |

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
