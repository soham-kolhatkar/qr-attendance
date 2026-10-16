# QR Attendance

Multi-institute attendance product: faculty project a QR code that rotates every 5 seconds;
students scan it with the mobile app. See [docs/PLAN.md](docs/PLAN.md) for the architecture,
the security design and the feature roadmap.

## Repository layout

```
apps/api      Backend API (Node 24, Fastify, PostgreSQL)   ← Feature 1
apps/web      Faculty projector page + dashboards          (Feature 4)
apps/mobile   Student app, Expo React Native               (Feature 5)
docs/         Plan and design notes
```

## Running locally

Requirements: Node 24+, Docker.

```bash
npm install                      # install all workspaces
npm run db:up                    # start PostgreSQL in Docker (port 55432)

cd apps/api
cp .env.example .env             # then set JWT_SECRET and the seed password
npm run db:migrate               # create tables
npm run db:seed                  # platform owner + a DEMO institute with sample users
npm run dev                      # API on http://localhost:3000
```

- Interactive API docs: http://localhost:3000/docs
- Demo logins (institute code `DEMO`, password `demo-pass-123`): `admin`, `hod.comp`,
  `prof.sharma`, `2024comp001`
- Platform owner login: no institute code, with the username and password from `.env`

## Tests

```bash
npm run db:up
npm run api:test        # runs against a separate qr_attendance_test database
npm run api:typecheck
```
