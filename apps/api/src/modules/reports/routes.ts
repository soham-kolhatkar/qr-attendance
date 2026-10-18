import { eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { ATTENDANCE_STATUSES, groups, institutes, subjects } from '../../db/schema.js';
import { resolveScope } from '../../lib/scope.js';
import { errorResponseSchema, idParamsSchema, paginated, paginationQuerySchema } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { loadUnitIndex } from '../structure/service.js';
import { type ExportMeta, PDF_MIME, registerPdf, registerWorkbook, studentsPdf, studentsWorkbook, XLSX_MIME } from './export.js';
import { instituteTimezone } from './query.js';
import {
  exportStudentReport,
  getRegister,
  getStudentReport,
  getSummary,
  listStudentReport,
  type ReportQuery,
  type StudentListQuery,
} from './service.js';

const security = [{ bearerAuth: [] }];
const tags = ['reports'];

const tally = {
  present: z.number().int(),
  absent: z.number().int(),
  excused: z.number().int(),
  total: z.number().int().describe('Finished sessions the student was on the list for'),
  percentage: z.number().nullable().describe('present ÷ (total − excused) × 100; null with nothing counted yet'),
};
const tallySchema = z.object(tally);
const termSchema = z.object({ id: z.uuid(), name: z.string(), startsOn: z.string(), endsOn: z.string() });
const studentRefSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  fullName: z.string(),
  rollNo: z.string().nullable(),
  unitPath: z.array(z.string()),
});

const filterSchema = z.object({
  termId: z.uuid().optional().describe('Default: the current term'),
  unitId: z.uuid().optional().describe('Students in this unit or below'),
  subjectId: z.uuid().optional(),
  offeringId: z.uuid().optional(),
  groupId: z.uuid().optional().describe('Students in this batch or group'),
});
const studentListQuerySchema = filterSchema.extend({
  below: z.stringbool().optional().describe('Only students below the minimum percentage'),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(['percentage', 'name', 'roll']).optional().describe('Default: percentage for defaulters, otherwise roll'),
});
const formatSchema = z.object({ format: z.enum(['xlsx', 'pdf']).default('xlsx') });

const STAFF = ['admin', 'hod', 'faculty'] as const;

/**
 * Attendance reports. What each caller sees: admins the whole institute, HODs their
 * department's students and the classes they teach, faculty the classes they teach.
 */
export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  const context = async (req: Parameters<typeof getInstituteAuth>[0]) => {
    const auth = getInstituteAuth(req);
    return { auth, scope: await resolveScope(app.db, auth) };
  };

  app.get(
    '/summary',
    {
      config: { apiKey: 'attendance:read' },
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: 'Dashboard: overall attendance, defaulters, trend by day, by class, by subject, weekday × hour',
        querystring: filterSchema,
        response: {
          200: z.object({
            term: termSchema.nullable(),
            minimumPercent: z.number().int(),
            overall: tallySchema,
            sessions: z.number().int(),
            students: z.object({ total: z.number().int(), below: z.number().int() }),
            trend: z.array(z.object({ date: z.string(), sessions: z.number().int(), percentage: z.number().nullable() })),
            byUnit: z.array(
              z.object({ unitId: z.uuid(), path: z.array(z.string()), students: z.number().int(), below: z.number().int(), ...tally }),
            ),
            bySubject: z.array(
              z.object({
                subjectId: z.uuid(),
                code: z.string(),
                name: z.string(),
                sessions: z.number().int(),
                students: z.number().int(),
                below: z.number().int(),
                ...tally,
              }),
            ),
            heatmap: z.array(
              z.object({
                weekday: z.number().int().describe('1 = Monday … 7 = Sunday'),
                hour: z.number().int(),
                sessions: z.number().int(),
                percentage: z.number().nullable(),
              }),
            ),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const { auth, scope } = await context(req);
      return getSummary(app.db, auth, scope, req.query, app.now());
    },
  );

  app.get(
    '/students',
    {
      config: { apiKey: 'attendance:read' },
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: 'Attendance per student; with below=true, the defaulter list',
        querystring: studentListQuerySchema.extend(paginationQuerySchema.shape),
        response: {
          200: paginated(z.object({ student: studentRefSchema, below: z.boolean(), ...tally })).extend({
            term: termSchema.nullable(),
            minimumPercent: z.number().int(),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const { auth, scope } = await context(req);
      return listStudentReport(app.db, auth, scope, withSort(req.query), app.now());
    },
  );

  app.get(
    '/students/export',
    {
      config: { apiKey: 'attendance:read' },
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: 'Download the student list as Excel (with a column per subject) or PDF',
        querystring: studentListQuerySchema.extend(formatSchema.shape),
      },
    },
    async (req, reply) => {
      const { auth, scope } = await context(req);
      const { format, ...query } = req.query;
      const data = await exportStudentReport(app.db, auth, scope, withSort(query), app.now());
      const meta = await exportMeta(app.db, auth.instituteId, query, app.now());
      const below = query.below ?? false;
      const file = format === 'pdf' ? await studentsPdf(data, meta, below) : await studentsWorkbook(data, meta, below);
      const name = `${below ? 'defaulters' : 'attendance'}-${slug(data.term?.name ?? 'no-term')}.${format}`;
      return reply
        .header('content-type', format === 'pdf' ? PDF_MIME : XLSX_MIME)
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(file);
    },
  );

  app.get(
    '/students/:id',
    {
      config: { apiKey: 'attendance:read' },
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: "One student's attendance by subject and session (faculty: the classes they teach)",
        params: idParamsSchema,
        querystring: z.object({ termId: z.uuid().optional() }),
        response: {
          200: z.object({
            student: studentRefSchema,
            term: termSchema.nullable(),
            minimumPercent: z.number().int(),
            overall: tallySchema,
            subjects: z.array(z.object({ subjectId: z.uuid(), code: z.string(), name: z.string(), ...tally })),
            sessions: z.array(
              z.object({
                sessionId: z.uuid(),
                startedAt: z.iso.datetime(),
                kind: z.string(),
                topic: z.string().nullable(),
                subject: z.object({ code: z.string(), name: z.string() }),
                status: z.enum(ATTENDANCE_STATUSES),
                method: z.enum(['qr', 'manual']).nullable(),
                markedAt: z.iso.datetime().nullable(),
                reason: z.string().nullable(),
              }),
            ),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const { auth, scope } = await context(req);
      return getStudentReport(app.db, auth, scope, req.params.id, req.query.termId, app.now());
    },
  );

  const registerSchema = z.object({
    offering: z.object({
      id: z.uuid(),
      subject: z.object({ code: z.string(), name: z.string() }),
      term: z.object({ id: z.uuid(), name: z.string() }),
      faculty: z.array(z.string()),
    }),
    minimumPercent: z.number().int(),
    sessions: z.array(
      z.object({
        id: z.uuid(),
        startedAt: z.iso.datetime(),
        kind: z.string(),
        topic: z.string().nullable(),
        open: z.boolean().describe('Still taking attendance; not counted yet'),
      }),
    ),
    students: z.array(
      studentRefSchema.extend({
        marks: z.array(z.enum(ATTENDANCE_STATUSES).nullable()).describe("One per session; null = not on that session's list"),
        below: z.boolean(),
        ...tally,
      }),
    ),
  });

  app.get(
    '/offerings/:id/register',
    {
      config: { apiKey: 'attendance:read' },
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: 'Attendance register for a class: every student × every session',
        params: idParamsSchema,
        response: { 200: registerSchema, 404: errorResponseSchema },
      },
    },
    async (req) => {
      const { auth, scope } = await context(req);
      return getRegister(app.db, auth, scope, req.params.id, app.now());
    },
  );

  app.get(
    '/offerings/:id/register/export',
    {
      config: { apiKey: 'attendance:read' },
      preHandler: guard(...STAFF),
      schema: {
        tags,
        security,
        summary: 'Download the attendance register as Excel or PDF',
        params: idParamsSchema,
        querystring: formatSchema,
      },
    },
    async (req, reply) => {
      const { auth, scope } = await context(req);
      const register = await getRegister(app.db, auth, scope, req.params.id, app.now());
      const meta = await exportMeta(app.db, auth.instituteId, {}, app.now());
      const { format } = req.query;
      const file = format === 'pdf' ? await registerPdf(register, meta) : await registerWorkbook(register, meta);
      const name = `register-${slug(register.offering.subject.code)}-${slug(register.offering.term.name)}.${format}`;
      return reply
        .header('content-type', format === 'pdf' ? PDF_MIME : XLSX_MIME)
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(file);
    },
  );
};

function withSort<T extends { below?: boolean; sort?: StudentListQuery['sort'] }>(query: T): T & { sort: StudentListQuery['sort'] } {
  return { ...query, sort: query.sort ?? (query.below ? 'percentage' : 'roll') };
}

/** File-name friendly: "2026-27 Odd Semester" → "2026-27-odd-semester". */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'report';

/** Who and what a download covers, in words. */
async function exportMeta(db: Db, instituteId: string, filter: ReportQuery, now: Date): Promise<ExportMeta> {
  const [institute] = await db.select({ name: institutes.name }).from(institutes).where(eq(institutes.id, instituteId));
  const parts: string[] = [];
  if (filter.unitId) parts.push((await loadUnitIndex(db, instituteId)).pathNames(filter.unitId).join(' › '));
  if (filter.groupId) {
    const [group] = await db.select({ name: groups.name }).from(groups).where(eq(groups.id, filter.groupId));
    if (group) parts.push(`batch ${group.name}`);
  }
  if (filter.subjectId) {
    const [subject] = await db
      .select({ code: subjects.code, name: subjects.name })
      .from(subjects)
      .where(inArray(subjects.id, [filter.subjectId]));
    if (subject) parts.push(`${subject.code} ${subject.name}`);
  }
  return {
    institute: institute?.name ?? '',
    scope: parts.length ? parts.join(' · ') : 'All students',
    timezone: await instituteTimezone(db, instituteId),
    generatedAt: now,
  };
}
