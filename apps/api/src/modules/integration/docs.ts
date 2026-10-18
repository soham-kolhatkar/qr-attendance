import { z } from 'zod';
import { API_SCOPES, WEBHOOK_EVENTS } from '../../db/schema.js';
import { EVENT_DATA, envelopeSchema } from '../webhooks/events.js';
import { FEED_LAG_MS } from './feeds.js';

const SCOPE_WORDS: Record<(typeof API_SCOPES)[number], string> = {
  'students:read': 'List and look up students.',
  'students:write': 'Create and update students, one at a time or in bulk.',
  'staff:read': 'The staff directory (names, roles, departments).',
  'staff:write': 'Create and update faculty and HODs in bulk (not admins).',
  'academic:read': 'Structure (departments, classes), batches and groups, terms, subjects, offerings and their class lists.',
  'attendance:read': 'Sessions, attendance marks, the change feeds, and reports (percentages, defaulters, registers).',
};

const GUIDE = (rateLimit: number) => `
The integration API lets an institute's own systems (an ERP, a student information system,
a parent portal) read attendance and keep students and staff in step. Everything here is
part of the same API the QR Attendance web app and phone app use.

## Getting started

1. An admin creates an **API key** in the web app: *Integrations → API keys*. They choose
   what it may do (its scopes). The key is shown once; store it like a password.
2. Send it with every request: \`Authorization: Bearer qra_…\`
3. Try \`GET /v1/integration/key\`: it tells you which institute and scopes the key has.

A key acts on behalf of the admin who created it, within its scopes. It stops working
when it is revoked or expires, or when that person is no longer an active admin. Every
change made with a key is recorded in the institute's activity log under the key's name.

## Scopes

| Scope | Allows |
|---|---|
${API_SCOPES.map((s) => `| \`${s}\` | ${SCOPE_WORDS[s]} |`).join('\n')}

Each endpoint below names the scope it needs.

## Limits and errors

- **${rateLimit} requests a minute per key.** Over that, the answer is \`429\` with a
  \`Retry-After\` header (seconds).
- Errors always look like \`{ "error": { "code": "…", "message": "…", "details": … } }\`.
  \`code\` is stable and meant for programs; \`message\` is for people.
- \`401 API_KEY_INVALID\`: wrong, revoked or expired key. \`403 API_KEY_SCOPE\`: the key
  lacks the scope. \`403 API_KEY_NOT_ALLOWED\`: the endpoint isn't open to API keys.
- Times are ISO 8601 in UTC. Ids are UUIDs.

## Keeping in sync: change feeds

\`GET /v1/integration/attendance\` (marks) and \`GET /v1/integration/sessions\` (classes held)
list what changed, oldest change first. Pass the \`cursor\` from each response back as
\`after\` on the next call, and store it between runs; while \`hasMore\` is true, call
again straight away. Start with no cursor (everything) or \`since\` (a date).

A row comes back again each time it changes (a student scans, a teacher changes a mark,
a session closes). Keep the latest. Changes appear about ${FEED_LAG_MS / 1000} seconds after
they happen, so the feed never skips one that was still being saved.

A session counts towards attendance once its \`status\` is \`closed\`. Cancelled sessions
don't count.

## Students and staff from your system

\`POST /v1/integration/students\` and \`POST /v1/integration/staff\` create and update up to
20,000 people per call, with the same rules as the spreadsheet import in the web app:

- People are matched by \`username\`. Missing fields never erase anything.
- Classes are given from the top level down, e.g. \`["Computer Engineering", "SY", "Div A"]\`.
  New classes and batches are created unless \`createMissing\` is false.
- Nothing is saved if any row has a problem: the answer is \`422 IMPORT_HAS_ERRORS\` with
  the report in \`error.details\`, listing every problem with its row number (counting from 1
  in the order sent). Send \`dryRun: true\` to check without saving.
- New accounts get a temporary password, returned once in \`credentials\`.

## Webhooks

Instead of polling, an admin can add a **webhook** (*Integrations → Webhooks*): an HTTPS
address of yours that is sent a \`POST\` the moment something happens. The events and their
bodies are listed under *Webhooks* below.

Each request has these headers:

| Header | |
|---|---|
| \`QRA-Event\` | The event type, e.g. \`attendance.recorded\` |
| \`QRA-Event-Id\` | The event; the same on retries. Use it to ignore repeats |
| \`QRA-Delivery\` | This attempt's delivery |
| \`QRA-Signature\` | \`t=<unix seconds>,v1=<hex HMAC-SHA256>\` |

**Check the signature** before trusting a request: compute HMAC-SHA256 of
\`<t>.<raw request body>\` with the webhook's signing secret (\`whsec_…\`, shown in the web
app), compare it with \`v1\` in constant time, and reject \`t\` more than 5 minutes old.

\`\`\`js
// Node.js (Express): app.post('/hooks/attendance', express.raw({ type: 'application/json' }), handler)
const crypto = require('node:crypto');
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = crypto.createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
\`\`\`

\`\`\`python
# Python
import hashlib, hmac, time
def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    expected = hmac.new(secret.encode(), f"{parts['t']}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return abs(time.time() - int(parts["t"])) < 300 and hmac.compare_digest(expected, parts["v1"])
\`\`\`

**Answer quickly with any 2xx status** (within 10 seconds) and do the work afterwards.
Anything else is retried: after 30 seconds, 2 and 10 minutes, then 30 minutes, 1, 3, 6
and 12 hours (about a day in all). A webhook that fails for a whole day is switched off
and the institute's admins are told. Events can arrive more than once and out of order:
use \`QRA-Event-Id\` and the times in the body.

For a complete record without webhooks, or to catch up after an outage, use the change
feeds above.
`;

/**
 * The integration API's own OpenAPI document: only the endpoints API keys can use, the
 * webhook events, and a guide. Built from the full document the server generates.
 */
export function integrationSpec(full: Record<string, unknown>, options: { rateLimit: number; publicUrl?: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  const usedTags = new Set<string>();
  for (const [path, item] of Object.entries((full.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>)) {
    for (const [method, op] of Object.entries(item)) {
      const scope = op['x-api-key-scope'];
      if (!scope) continue;
      (paths[path] ??= {})[method] = { ...op, security: [{ apiKey: [] }] };
      for (const tag of (op.tags as string[] | undefined) ?? []) usedTags.add(tag);
    }
  }
  const webhooks = Object.fromEntries(
    WEBHOOK_EVENTS.map((type) => [
      type,
      {
        post: {
          summary: type,
          description: EVENT_DATA[type].description,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: z.toJSONSchema(envelopeSchema(type, EVENT_DATA[type]), { unrepresentable: 'any' }) } },
          },
          responses: { '2XX': { description: 'Received. Anything else, or no answer within 10 seconds, is retried.' } },
        },
      },
    ]),
  );
  return {
    openapi: '3.1.0',
    info: { title: 'QR Attendance integration API', version: '1', description: GUIDE(options.rateLimit) },
    ...(options.publicUrl && { servers: [{ url: options.publicUrl }] }),
    tags: ((full.tags as { name: string }[] | undefined) ?? [...usedTags].map((name) => ({ name }))).filter((t) => usedTags.has(t.name)),
    paths,
    webhooks,
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'API key (qra_…)' } } },
  };
}

/** The docs page: Swagger UI (already served by the API under /docs/static) showing the document above. */
export const integrationDocsPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QR Attendance integration API</title>
    <link rel="stylesheet" href="/docs/static/swagger-ui.css" />
    <style>body { margin: 0; } .swagger-ui .topbar { display: none; }</style>
  </head>
  <body>
    <div id="docs"></div>
    <script src="/docs/static/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({ url: '/v1/integration/openapi.json', dom_id: '#docs', deepLinking: true, defaultModelsExpandDepth: 0 });
    </script>
  </body>
</html>
`;
