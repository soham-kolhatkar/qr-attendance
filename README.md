# QR Attendance

Multi-institute attendance product: faculty project a QR code that rotates every 5 seconds;
students scan it with the mobile app. See [docs/PLAN.md](docs/PLAN.md) for the architecture,
the security design and the feature roadmap.

## Repository layout

```
apps/api      Backend API (Node 24, Fastify, PostgreSQL)    ← Features 1–3
apps/web      Web app: admin screens, teacher sessions,     ← Feature 4
              full-screen projector QR (React, Mantine)
apps/mobile   Student app (Expo React Native, Android):       ← Feature 5
              sign in, link the phone, scan, my attendance
docs/         Plan and design notes
```

## Online test environment

The product can run on Render's free plan at one HTTPS address (web app + API). See
[docs/DEPLOY.md](docs/DEPLOY.md) for the setup steps and the free plan's limits.

## Running locally

Requirements: Node 24+, Docker. Packages always come from the public npm registry (see
`.npmrc`), whatever registry your machine is configured for.

```bash
npm install                      # install all workspaces
npm run db:up                    # start PostgreSQL in Docker (port 55432)

cd apps/api
cp .env.example .env             # then set JWT_SECRET and the seed password
npm run db:migrate               # create tables
npm run db:seed                  # platform owner + a DEMO institute with sample data
npm run dev                      # API on http://localhost:3000

# in a second terminal, from the repository root
npm run web:dev                  # web app on http://localhost:5173
```

- Interactive API docs: http://localhost:3000/docs
- Integration API docs (what institutes' own systems can use with an API key, and the
  webhook events): http://localhost:3000/docs/integration
- Demo logins (institute code `DEMO`, password `demo-pass-123`):
  - `admin` (institute admin)
  - `hod.comp` (HOD of Computer Engineering)
  - `prof.sharma` (faculty, teaches CS301 to SY Div A and the CS302L lab to batch A1)
  - students `2024comp001`–`004` (SY Div A, batches A1/A2) and `2024comp051`–`052` (SY Div B)
- Platform owner login: no institute code, with the username and password from `.env`

The demo structure is `Department › Year › Division`, with Computer Engineering › SY ›
Div A and Div B. Each institute defines its own levels, so this is just an example.

**Try it in the web app** (http://localhost:5173): sign in as `admin` to see the setup
screens and **Reports** (the demo comes with six weeks of past classes), or as
`prof.sharma` → **My classes** → **Take attendance** → **Show QR on projector**, and scan
the code with the student app. **Register** on a class shows every student × session.

**Try an attendance session through the API** (in http://localhost:3000/docs):
1. Log in as `prof.sharma`. Find the CS301 offering with `GET /v1/offerings?mine=true`,
   then start a session with `POST /v1/sessions`, giving it that `offeringId`.
2. `GET /v1/sessions/{id}/qr` gives the code the projector would show right now.
3. Scans must be signed by the student's linked phone, which only the app can do. To try
   a scan from the API docs, sign in as `admin` and switch the requirement off with
   `PATCH /v1/settings/attendance` `{"requireRegisteredPhone": false}`; then log in as
   `2024comp001` and send the code to `POST /v1/attendance/scan` within about 15 seconds.
4. As `prof.sharma`, `GET /v1/sessions/{id}/records` shows who is present.
   `POST /v1/sessions/{id}/mark` marks a student by hand; a reason is required.

## Student app (Android)

The app lives in `apps/mobile` with its own packages (it is not part of the npm workspaces,
so deploying the API never installs mobile tooling).

```bash
cd apps/mobile
npm install
npm run typecheck
npm run build:android            # signed APK in apps/mobile/dist (≈7 minutes the first time)
```

- The build needs the Android toolchain: `scripts/setup-android.sh` installs it.
- The first build creates the app's **release signing key** in `~/.qr-attendance`. Back
  that folder up: updates must be signed with the same key, and the server only accepts
  phones running an app signed with it (`ANDROID_SIGNING_CERT_SHA256`, printed by the build).
- `EXPO_PUBLIC_API_URL` picks the server (default: the Render test environment), and
  `EXPO_PUBLIC_ALLOW_SERVER_CHANGE=true` builds a testing version whose sign-in screen can
  switch servers.
- Linking needs a real phone: emulators have no secure hardware, so the server refuses them.
- Push notifications need the Firebase project's `google-services.json` in
  `~/.qr-attendance` (or `GOOGLE_SERVICES_JSON=<path>`) when building; without it the app
  works but only shows notifications inside the app. See docs/DEPLOY.md.

## Tests

```bash
npm run db:up
npm run api:test        # API integration tests (separate qr_attendance_test database)
npm run api:typecheck
npm run web:test        # web unit tests
npm run e2e             # real-browser end-to-end tests; screenshots in apps/web/e2e/screenshots
```

The first `npm run e2e` needs a browser: `cd apps/web && npx playwright install chromium`.

After changing the API, regenerate the typed clients with `npm run gen:api -w apps/web`
and `npm run gen:api --prefix apps/mobile`; the type-checks then flag anything that no
longer fits.
