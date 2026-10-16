# QR Attendance — Architecture & Roadmap

A multi-institute (SaaS) attendance product. Faculty start a session and project a QR
code that changes every 5 seconds. Students scan it with the mobile app and are marked
present.

## 1. Goals

| Goal | How |
|---|---|
| Fast | A class of 60 marks attendance in under a minute, compared with 5–10 minutes for a roll call |
| Secure | Rotating signed QR codes, one phone per student (hardware-bound key), audit trail |
| Reliable | Stateless API that scales horizontally, idempotent scans, server-synced clocks |
| Transparent | Every manual change is logged with who, when and why; students can see and dispute their records |
| Flexible | Each institute defines its own structure (year/branch/division/batch…); nothing hardcoded |
| Integrable | Versioned REST API with an OpenAPI spec, so institute ERPs can integrate later |

**Scale target:** ~10,000 students, 20–30 classes running at the same time. The worst-case
peak is about 2,000 scans in 1–2 minutes when periods start, which is under 50 requests per
second. One small API instance plus Postgres handles this comfortably. The API keeps no
state between requests, so we can add instances later.

## 2. System overview

```
 ┌────────────────────┐        ┌───────────────────────────┐        ┌──────────────┐
 │ Web app (React)    │ HTTPS  │ API (Node + Fastify)      │  SQL   │ PostgreSQL   │
 │ - Faculty QR page  ├───────►│ - Auth & roles            ├───────►│ (multi-      │
 │   (projector)      │◄───SSE─┤ - Structure / users       │        │  tenant)     │
 │ - Admin / HOD /    │        │ - Sessions & QR engine    │        └──────────────┘
 │   Faculty dashbd.  │        │ - Scan verification       │
 └────────────────────┘        │ - Device attestation      │        ┌──────────────┐
 ┌────────────────────┐ HTTPS  │ - Reports / exports       ├───────►│ Email / Push │
 │ Mobile app (Expo   ├───────►│ - Audit log               │        └──────────────┘
 │ React Native)      │        │ - Integration API (later) │
 │ - Scan QR          │        └───────────────────────────┘
 │ - My attendance    │
 └────────────────────┘
```

## 3. Security design

### 3.1 One phone ↔ one student (device binding)

Android 10+ and iOS do not give apps the IMEI or the real MAC address, so we can't use
either. Instead we bind each student to a **cryptographic key generated inside the phone's
secure hardware**, which cannot be copied off the phone.

1. **Registration.** On first login the app asks the server for a one-time challenge and
   creates a key in secure hardware: Android Keystore with key attestation, or iOS App
   Attest via `@expo/app-integrity`. The server checks the attestation against the
   Google/Apple root certificates, the challenge, our app ID and signing certificate, and
   that the key really is in hardware. It then stores the public key against the student.
2. **Every scan is signed** with that key. A request from any other phone, an emulator, a
   modified app or a script fails verification.
3. **One phone per student, one student per phone.**
   - A student has at most one active device.
   - A phone already bound to student A cannot be bound to student B. We detect this with
     ANDROID_ID on Android, and with the vendor ID plus a DeviceCheck bit on iOS.
4. **Changing phones** (new phone or reinstall): the student raises a request, and an
   admin or HOD approves it. The old key is revoked. The institute sets a cooldown, and
   every change goes in the audit log.
5. **Rooted or jailbroken devices.** Play Integrity and App Attest checks can reject them.
   This is a setting each institute can turn on.

### 3.2 Rotating QR code

- Each session gets a random 256-bit secret `K`.
- `step = floor(serverTime / 5s)`
- `code = HMAC-SHA256(K, sessionId:step)`, truncated to 96 bits
- The QR text is `QA1:<session>:<step>:<code>`, about 45 characters. That fits a small QR
  version, which stays readable from the back of a classroom when projected.
- The faculty page syncs its clock with the server and redraws the QR every 5 seconds,
  with a countdown bar. It works out each code locally, so a network blip in class doesn't
  stop the QR from changing.
- The server accepts the current step and the previous ones within a short window (about
  10–15 seconds, set per institute). A screenshot sent on WhatsApp has expired by the time
  someone opens it.

### 3.3 Scan verification (server)

For each scan the server checks, in order:

1. The student is logged in.
2. The device is active and belongs to this student.
3. The device signature is valid.
4. The QR code's HMAC is valid and its step is fresh.
5. The session is open.
6. The student is in the session's audience (division, batch, elective…).
7. Then it records attendance. Recording is idempotent, because there is one row per
   student per session.

The scan screen shows a green tick with the subject name.

### 3.4 Known limitation (by design, for now)

Rotating QR plus device binding stops screenshots, shared phones and scripted scans. It
**does not** stop two things:

- A live video call to a friend outside the room.
- A student carrying an absent friend's phone.

Proof of presence would close these gaps: a BLE beacon, a Wi-Fi BSSID check, a geofence or
a selfie. It is deferred until an institute asks for it. The scan pipeline has a
pluggable "evidence" step so we can add it without a redesign. Until then, the faculty
page shows a **live headcount**, so a mismatch with the heads in the room is easy to spot.

### 3.5 General

- Passwords are hashed with Argon2id.
- Access tokens are JWTs that expire after 15 minutes. Refresh tokens rotate, and reuse of
  an old refresh token is detected and kills that login.
- Every request checks that the user and institute are still active. Disabling an account
  therefore takes effect immediately.
- Login is rate-limited.
- Every query is scoped to the caller's institute (tenant isolation), and tests cover this.
- An audit log records logins, user changes, structure changes, manual attendance edits and
  device changes.

## 4. Configurable academic structure (per institute)

There are no hardcoded "year/division/branch" fields. Each institute configures three things.

- **Structure levels.** An ordered list of level names, for example
  `Department › Program › Year › Division` or `School › Class › Section`.
- **Units.** A tree of nodes that follows those levels, for example
  `Computer Engg › B.Tech › SY › Div A`. Each student belongs to one leaf unit. A HOD is
  scoped to a subtree.
- **Groups.** Flexible sets of students for lab batches (`A1`, `A2`), electives, tutorials
  and so on. A student can be in any number of groups.

A **course offering** (subject + term + faculty) has an **audience** made of units and/or
groups. A **session** happens once per lecture or lab and can narrow that audience, for
example a lab for batch A2 only. All of this can be bulk-imported from Excel/CSV.

**Who can do what:**

| | Admin | HOD | Faculty | Student |
|---|---|---|---|---|
| Structure (levels, units) | manage | view | view | — |
| Groups / batches | manage | manage within their department | view | — |
| Students | create, edit, import | view their department | via their classes' rosters | own profile |
| Staff accounts | create, edit, import | — | — | — |
| Terms | manage | view | view | — |
| Subjects | manage | manage their department's | view | — |
| Offerings | manage | manage those taught to their department | view the ones they teach | — |

**Import rules (students and staff):**

- **Preview first.** Every upload is a preview (dry run) unless the admin confirms. If any
  row has an error, nothing is saved.
- **Matching.** Rows match existing accounts by username. Blank cells never erase data. A
  filled Groups cell replaces the student's groups.
- **New classes.** Classes and batches that don't exist yet are created and listed in the
  preview, which is where typos like "Computer Engg" get caught. This can be switched off.
- **Passwords.** New accounts get one-time temporary passwords, returned once after the
  import.
- **Speed.** Measured on 10,000 students: preview 0.2 s, commit 7.6 s, re-import of the
  same file 0.3 s.

## 5. Tech stack (free until the first paying client)

| Part | Choice | Free hosting option |
|---|---|---|
| API | Node 24, TypeScript, Fastify, Zod, Drizzle ORM | Docker image → Google Cloud Run free tier / Oracle Always-Free VM (decided at deploy time) |
| Database | PostgreSQL 17 | Neon or Supabase free tier |
| Web | React + Vite, Tailwind + shadcn/ui, TanStack Query, Recharts | Cloudflare Pages / Vercel |
| Mobile | Expo (React Native) dev builds, `expo-camera`, `@expo/app-integrity` | EAS Build free tier |
| Email / push | Brevo or Resend free tier / Expo push | free |
| API docs | OpenAPI generated from the Zod schemas, at `/docs` | — |

**Costs we cannot avoid:**

- Apple Developer Program, **$99/year**. It is required for iOS builds on real phones, for
  TestFlight, the App Store and App Attest.
- Google Play, **$25 one-time**. During development the Android app can be installed
  directly as an APK for free.

Everything else stays on free tiers until a client signs.

## 6. Roadmap: features, each one a review checkpoint

| # | Feature | Contents |
|---|---|---|
| 1 ✅ | Foundation | Monorepo, API server, Postgres in Docker, migrations, institutes (tenants), users & roles, login/refresh/logout, audit log, OpenAPI docs, automated tests |
| **2** 🔍 | **Academic structure** | Structure levels, unit tree, groups/batches, terms, subjects, course offerings, student profiles, HOD scope, Excel/CSV bulk import |
| 3 | Attendance engine | Sessions, rotating-QR engine, scan verification, manual marking with reasons, auto-close and absentees, live headcount (SSE) |
| 4 | Web app I | Login, admin screens for structure, users and imports, faculty "start session" and projector QR page with live count |
| 5 | Mobile app + device binding | Expo app: login, device registration with hardware attestation, QR scanner, my attendance; device change requests and approvals |
| 6 | Reports & dashboards | Student, faculty, HOD and admin dashboards; defaulter list (< threshold); trends and heatmaps; Excel/PDF export |
| 7 | Corrections & notifications | Attendance correction requests and approvals, audit-log viewer, email and push alerts (e.g. low attendance) |
| 8 | Integration API | Per-institute API keys, webhooks (e.g. `attendance.recorded`), published OpenAPI docs |
| 9 | Deploy & harden | Free-tier cloud deploy, CI, backups, load test (10k students / 30 parallel classes), monitoring |

**Later, on request:** proof of presence (BLE / Wi-Fi / GPS / selfie), offline scan queue,
parent role, desktop wrapper for the faculty screen (Tauri), SSO.
