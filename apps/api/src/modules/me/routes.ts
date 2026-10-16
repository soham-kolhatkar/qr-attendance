import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { groupMembers, groups, institutes, staffProfiles, students, users } from '../../db/schema.js';
import { errorResponseSchema } from '../../lib/validation.js';
import { getAuth, guard } from '../../plugins/auth.js';
import { loadUnitIndex } from '../structure/service.js';
import { toUserDto, userDtoSchema } from '../users/dto.js';

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/me',
    {
      preHandler: guard(),
      schema: {
        tags: ['auth'],
        summary: 'The logged-in user, their institute and where they sit in its structure',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            user: userDtoSchema,
            institute: z.object({ id: z.uuid(), code: z.string(), name: z.string() }).nullable(),
            student: z
              .object({
                unitId: z.uuid(),
                unitPath: z.array(z.string()),
                rollNo: z.string().nullable(),
                groups: z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.string() })),
              })
              .nullable(),
            staff: z
              .object({ unitId: z.uuid().nullable(), unitPath: z.array(z.string()), designation: z.string().nullable() })
              .nullable(),
          }),
          401: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const userId = getAuth(req).userId;
      const [row] = await app.db
        .select({
          user: users,
          institute: { id: institutes.id, code: institutes.code, name: institutes.name },
          student: students,
          staff: staffProfiles,
        })
        .from(users)
        .leftJoin(institutes, eq(institutes.id, users.instituteId))
        .leftJoin(students, eq(students.userId, users.id))
        .leftJoin(staffProfiles, eq(staffProfiles.userId, users.id))
        .where(eq(users.id, userId))
        .limit(1);
      const { user, institute, student, staff } = row!;

      const index = user.instituteId && (student || staff?.unitId) ? await loadUnitIndex(app.db, user.instituteId) : null;
      const studentGroups = student
        ? await app.db
            .select({ id: groups.id, name: groups.name, kind: groups.kind })
            .from(groupMembers)
            .innerJoin(groups, eq(groups.id, groupMembers.groupId))
            .where(eq(groupMembers.studentId, userId))
            .orderBy(asc(groups.name))
        : [];

      return {
        user: toUserDto(user),
        institute,
        student: student
          ? {
              unitId: student.unitId,
              unitPath: index!.pathNames(student.unitId),
              rollNo: student.rollNo,
              groups: studentGroups,
            }
          : null,
        staff: staff
          ? {
              unitId: staff.unitId,
              unitPath: staff.unitId ? index!.pathNames(staff.unitId) : [],
              designation: staff.designation,
            }
          : null,
      };
    },
  );
};
