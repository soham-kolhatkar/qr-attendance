import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { errorResponseSchema } from '../../lib/validation.js';
import { getInstituteAuth, guard } from '../../plugins/auth.js';
import { listLevels } from '../structure/service.js';
import { importStaff, STAFF_FIELDS } from './staff.js';
import { buildTemplate, parseSpreadsheet } from './sheet.js';
import { importStudents, STUDENT_FIELDS } from './students.js';

const security = [{ bearerAuth: [] }];
const tags = ['imports'];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const optionsSchema = z.object({
  dryRun: z.stringbool().default(true).describe('Preview only (default). Set false to save.'),
  createMissing: z
    .stringbool()
    .default(true)
    .describe('Create classes/groups that do not exist yet (they are listed in the preview)'),
});

const reportSchema = z.object({
  dryRun: z.boolean(),
  summary: z.object({
    rows: z.number().int(),
    create: z.number().int(),
    update: z.number().int(),
    unchanged: z.number().int(),
    errors: z.number().int(),
  }),
  newUnits: z.array(z.string()),
  newGroups: z.array(z.string()),
  errors: z.array(z.object({ row: z.number().int(), column: z.string().optional(), message: z.string() })),
  warnings: z.array(z.string()),
  credentials: z
    .array(z.object({ username: z.string(), fullName: z.string(), temporaryPassword: z.string() }))
    .optional()
    .describe('Only after a successful save: temporary passwords for new accounts. Shown once.'),
});

const COMMON_INSTRUCTIONS = [
  'Upload the file once as a preview (dry run). Nothing is saved until you confirm, and nothing is saved if any row has an error.',
  'Existing accounts (same Username) are updated. Blank cells never erase existing data.',
  'Missing classes are created automatically unless you turn that off; the preview lists every new one so you can spot typos.',
  'New accounts get a temporary password, shown once after the import. They must change it at first login.',
  'Supported formats: .xlsx (first sheet is read) and .csv (UTF-8). Up to 20,000 rows per file.',
];

function studentInstructions(levelNames: string[]) {
  return [
    'STUDENT IMPORT — one row per student.',
    'Username: the login ID, usually the enrollment number. Must be unique in the institute.',
    `${levelNames.join(', ')}: the student's class, filled from the top level down.`,
    'Groups: comma-separated batches / electives, e.g. "A1, ML Elective". Each is looked up in the student’s class and the levels above it; a filled cell replaces the student’s groups.',
    ...COMMON_INSTRUCTIONS,
  ];
}

function staffInstructions(levelNames: string[]) {
  return [
    'STAFF IMPORT — one row per faculty member, HOD or admin.',
    'Username: the login ID, e.g. employee ID or email. Must be unique in the institute.',
    'Role: faculty, hod or admin (blank = faculty). Roles of existing accounts are not changed by an import.',
    `${levelNames.join(', ')}: the person's department / home unit (usually only the top level). Required for HODs: it is the part of the institute they manage.`,
    ...COMMON_INSTRUCTIONS,
  ];
}

/** Bulk onboarding from Excel/CSV. Admin only. */
export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', guard('admin'));

  const kinds = {
    students: { fields: STUDENT_FIELDS, run: importStudents, instructions: studentInstructions },
    staff: { fields: STAFF_FIELDS, run: importStaff, instructions: staffInstructions },
  } as const;

  for (const [kind, spec] of Object.entries(kinds)) {
    app.get(
      `/${kind}/template`,
      {
        schema: {
          tags,
          security,
          summary: `Download an Excel template for the ${kind} import, with this institute's structure columns`,
        },
      },
      async (req, reply) => {
        const levelNames = (await listLevels(app.db, getInstituteAuth(req).instituteId)).map((l) => l.name);
        // Structure columns sit between the personal details and the Groups column.
        const columns = [
          ...spec.fields.filter((f) => f.key !== 'groups').map((f) => f.label),
          ...levelNames,
          ...spec.fields.filter((f) => f.key === 'groups').map((f) => f.label),
        ];
        const file = await buildTemplate(columns, spec.instructions(levelNames));
        return reply
          .header('content-type', XLSX_MIME)
          .header('content-disposition', `attachment; filename="${kind}-import-template.xlsx"`)
          .send(file);
      },
    );

    app.post(
      `/${kind}`,
      {
        config: { fileUpload: true },
        schema: {
          tags,
          security,
          summary: `Import ${kind} from an .xlsx or .csv file (multipart field "file")`,
          consumes: ['multipart/form-data'],
          querystring: optionsSchema,
          response: { 200: reportSchema, 400: errorResponseSchema, 409: errorResponseSchema, 422: errorResponseSchema },
        },
      },
      async (req) => {
        const file = await req.file();
        if (!file) throw badRequest('FILE_REQUIRED', 'Attach the spreadsheet in a multipart field named "file"');
        const sheet = await parseSpreadsheet(await file.toBuffer());
        return spec.run(app.db, getInstituteAuth(req), sheet, req.query, req.ip);
      },
    );
  }
};
