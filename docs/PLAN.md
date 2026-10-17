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

1. **Linking.** After the student signs in, the app asks the server for a one-time
   challenge (signed by the server, valid 10 minutes) and creates an ECDSA P-256 signing
   key in the Android Keystore with that challenge built into the key's **attestation**. The
   hardware signs a certificate chain for the key that ends at a Google root. The server
   checks:
   - the chain is correctly signed all the way to one of Google's roots (matched by public
     key), intermediates are in date, and no certificate is on Google's revocation list
     (fetched hourly; if Google can't be reached the last list is used);
   - the key was **generated** (not imported) inside the **TEE or StrongBox** (software keys,
     i.e. emulators, are refused), is a P-256 signing key, and was made for our challenge;
   - the requesting app is ours: package name and **signing certificate** (a re-signed,
     modified copy of the app is refused; `ANDROID_SIGNING_CERT_SHA256`).

   It then stores the public key against the student. Tested against 89 attestation chains
   from real phones of 20+ makers, and against attestation formats of future Android
   releases (unknown fields are ignored).
2. **Every scan is signed** with that key: the app signs `QAS1|<device id>|<scanned code>`.
   A request from any other phone, an emulator, a modified app or a script fails. Each
   attendance record keeps which phone marked it.
3. **One phone per student, one student per phone.**
   - A student has at most one active phone (enforced by a unique index).
   - A phone already linked to student A can't be linked to student B. The app sends the
     phone's ANDROID_ID (stable for our app until a factory reset); the server stores only
     a hash, scoped to the institute.
4. **Changing phones.**
   - First phone: linked straight away.
   - The app reinstalled on the **same, unmodified** phone (same ANDROID_ID, verified boot,
     locked bootloader): the new key replaces the old one straight away.
   - A **different** phone (or a rooted one): a request that an admin or the student's HOD
     approves on the **Phones** page, which shows the new and old phone and how many phones
     the student has used. The old phone keeps working until approval. Newer requests
     supersede older ones.
   - Lost or stolen phone: the admin **unlinks** it; the student's next phone links without
     approval.
   - Every link, request, approval, rejection and unlink is in the audit log.
5. **Rooted phones.** The attestation reports whether the bootloader is unlocked or the
   phone runs modified software. Such phones still hold their key in hardware; the Phones
   page flags them as "Modified phone" and a reinstall on one always needs approval.
   Refusing them outright (and Play Integrity) is a possible per-institute setting later.
6. **The requirement is a setting.** "Students must scan with their linked phone" is on by
   default; an admin can switch it off (for example while students can't install the app)
   and the change applies straight away.
7. **iOS** will use App Attest (needs the $99/year Apple developer account); until then the
   app is Android-only and iPhone users are marked by their teacher.

### 3.2 Rotating QR code

- Each session gets a random 256-bit secret `K`.
- `step = floor(serverTime / rotation)`, with a rotation of 5 s by default.
- The QR text is `QA1.<session id>.<step>.<code>`:
  - `code` is HMAC-SHA256(K, `QA1.<session id>.<step>`), truncated to 80 bits.
  - The session id and code are written in base32 (upper-case letters and digits).
  - That's about 54 characters, which fits a version-3 QR code in alphanumeric mode (29×29
    squares). Big squares stay readable from the back of a classroom.
- The faculty page gets `K` once, corrects its clock against the server, and works out
  each code itself. A network blip in class doesn't stop the QR from changing.
- A code is accepted while it is on screen, plus a grace period after it is replaced (10 s
  by default) to cover slow mobile data. A forwarded screenshot stops working within
  about 15 s.
- Each institute can tune three settings: the rotation interval, the grace period, and
  how long scanning stays open (10 minutes by default). A session uses the values in force
  when it starts.

### 3.3 Scan verification (server)

For each scan the server checks, in order:

1. The student is logged in.
2. The QR code is well-formed, belongs to a session of the student's institute, and its
   signature is valid. Nothing about the session is revealed before this check passes.
3. The session is open, not closed or cancelled.
4. The code is fresh.
5. The scan is signed by the student's linked phone (§3.1), unless the institute has
   switched that requirement off.
6. The student is on the session's list. That list is taken when the session starts, so
   later class changes never rewrite history.
7. Then it marks the student present.
   - Scanning again is harmless.
   - A status the teacher set by hand is never overridden by a scan.

The scan screen shows a green tick with the subject name.

**Measured on a laptop**, with 30 classes and 2,010 students:
- Scans spread over 20 seconds: the median is 11 ms, the 95th percentile is 23 ms, and
  nothing failed.
- All 2,010 scans fired at the same instant: about 330 scans/s, all done in 5 s, and
  nothing failed.

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
| Students' phones | approve switches, unlink | the same, for their department | — | link their own phone |

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

## 5. Reports

**How attendance is counted** (the same everywhere: dashboards, downloads, the student app):

- A session counts once it has **finished**: closed by the teacher or by time. Cancelled
  sessions never count; a re-opened session stops counting until it finishes again.
- **Attendance % = present ÷ (sessions − excused).** An excused absence (e.g. a medical
  certificate) counts neither for nor against the student.
- A student below the institute's **minimum** (75% by default, set under Settings) is a
  **defaulter**. Exactly at the minimum is not below it.

**Who sees what:** admins the whole institute; a HOD their department's students plus the
classes they teach; faculty the classes they teach; students only themselves.

**What's there:**
- **Reports page:** the term's attendance, defaulters, trend by day, by class, by subject,
  and a weekday × hour heatmap. Filter by class, subject or batch; click a class or
  subject to filter by it.
- **Student list:** defaulters (lowest first) or everyone. Click a student for their
  subjects and every session, including who marked it by hand and why.
- **Class register:** students × sessions (P/A/E), for teachers from *My classes* and for
  admins from *Offerings*.
- **Downloads:** Excel (with a column per subject, or the full register) and PDF for
  printing. Each file states the term, filters, minimum and how it was counted.

**Speed at 10,000 students** (a term of 48,600 sessions and 2.7 million attendance records,
measured on a laptop): whole-institute dashboard 0.4 s, one department 0.13 s, one class or
one teacher 0.02 s, defaulter list 0.14 s, class register 0.02 s. The dashboards read
**running totals** (per student per class, and per session) instead of every record. The
totals are recounted per class when something changes what counts: a session finishes, is
re-opened or cancelled, a mark is changed by hand, or a student moves class. Recounting a
class takes milliseconds and happens in the background within 15 seconds, or before a
report is read if it hasn't yet, so reports always match the records. (Reading the records
directly took 14.6 s for the same dashboard.)

## 6. Tech stack (free until the first paying client)

| Part | Choice | Free hosting option |
|---|---|---|
| API + web app | Node 24, TypeScript, Fastify, Zod, Drizzle ORM; the API also serves the built web app (one address, no CORS) | Render free web service (test environment, `render.yaml`) |
| Database | PostgreSQL 17 | Neon free plan (direct connection; see docs/DEPLOY.md) |
| Web | React + Vite, Mantine UI, TanStack Query, React Router, typed API client generated from OpenAPI | Cloudflare Pages / Vercel |
| Mobile | Expo SDK 58 (React Native), Expo Router, `expo-camera`, a small native module for Keystore keys (`apps/mobile/modules/device-key`) | Built locally (`npm run build:android`); EAS Build later |
| Email / push | Brevo or Resend free tier / Expo push | free |
| API docs | OpenAPI generated from the Zod schemas, at `/docs` | — |

**Costs we cannot avoid:**

- Apple Developer Program, **$99/year**. It is required for iOS builds on real phones, for
  TestFlight, the App Store and App Attest.
- Google Play, **$25 one-time**. During development the Android app can be installed
  directly as an APK for free.

Everything else stays on free tiers until a client signs.

## 7. Roadmap: features, each one a review checkpoint

| # | Feature | Contents |
|---|---|---|
| 1 ✅ | Foundation | Monorepo, API server, Postgres in Docker, migrations, institutes (tenants), users & roles, login/refresh/logout, audit log, OpenAPI docs, automated tests |
| 2 ✅ | Academic structure | Structure levels, unit tree, groups/batches, terms, subjects, course offerings, student profiles, HOD scope, Excel/CSV bulk import |
| 3 ✅ | Attendance engine | Sessions, rotating-QR engine, scan verification, manual marking with reasons, auto-close and absentees, live headcount (SSE) |
| 4 ✅ | Web app I | Login, admin screens for structure, users and imports, faculty "start session" and projector QR page with live count |
| 5 ✅ | Mobile app + device binding | Expo app (Android): login, phone linking with hardware key attestation, QR scanner, my attendance; phone change requests and approvals (web "Phones" page) |
| 6 ✅ | Reports & dashboards | Reports page (trend, by class, by subject, weekday × hour), defaulter list with a per-institute minimum, student drill-down, class register, Excel/PDF downloads, running totals for speed at 10k students |
| 7 | Corrections & notifications | Attendance correction requests and approvals, audit-log viewer, email and push alerts (e.g. low attendance) |
| 8 | Integration API | Per-institute API keys, webhooks (e.g. `attendance.recorded`), published OpenAPI docs |
| 9 | Deploy & harden | Free-tier cloud deploy, CI, backups, load test (10k students / 30 parallel classes), monitoring |

**Later, on request:** proof of presence (BLE / Wi-Fi / GPS / selfie), offline scan queue,
parent role, desktop wrapper for the faculty screen (Tauri), SSO.
