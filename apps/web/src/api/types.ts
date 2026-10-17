import type { paths } from './schema';

type JsonOf<R> = R extends { content: { 'application/json': infer B } } ? B : never;
type Success<R> = R extends { 200: infer A } ? A : R extends { 201: infer B } ? B : never;

/** The JSON body of a successful response, e.g. `Ok<'/v1/me', 'get'>`. */
export type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { responses: infer R }
  ? JsonOf<Success<R>>
  : never;

export type Me = Ok<'/v1/me', 'get'>;
export type Role = Me['user']['role'];
export type Structure = Ok<'/v1/structure/', 'get'>;
export type Unit = Structure['units'][number];
export type Level = Structure['levels'][number];
export type Group = Ok<'/v1/groups/', 'get'>[number];
export type Student = Ok<'/v1/students/', 'get'>['items'][number];
export type ManagedUser = Ok<'/v1/users/', 'get'>['items'][number];
export type Term = Ok<'/v1/terms/', 'get'>[number];
export type Subject = Ok<'/v1/subjects/', 'get'>[number];
export type Offering = Ok<'/v1/offerings/', 'get'>['items'][number];
export type RosterEntry = Ok<'/v1/offerings/{id}/students', 'get'>[number];
export type Session = Ok<'/v1/sessions/{id}', 'get'>;
export type SessionRecord = Ok<'/v1/sessions/{id}/records', 'get'>[number];
export type QrConfig = Ok<'/v1/sessions/{id}/qr-config', 'get'>;
export type AttendanceSettings = Ok<'/v1/settings/attendance', 'get'>;
export type Institute = Ok<'/v1/platform/institutes', 'get'>['items'][number];
export type ImportReport = Ok<'/v1/imports/students', 'post'>;
export type ManagedDevice = Ok<'/v1/devices/', 'get'>['items'][number];
export type Device = Ok<'/v1/devices/{id}/approve', 'post'>;
export type DeviceStatus = Device['status'];
export type ReportSummary = Ok<'/v1/reports/summary', 'get'>;
export type StudentReportRow = Ok<'/v1/reports/students', 'get'>['items'][number];
export type StudentReport = Ok<'/v1/reports/students/{id}', 'get'>;
export type Register = Ok<'/v1/reports/offerings/{id}/register', 'get'>;
export type AttendanceStatus = SessionRecord['status'];
export type SessionCounts = Session['counts'];

/** Events on GET /v1/sessions/{id}/live (mirrors the API's LiveEvent). */
export type LiveEvent =
  | {
      type: 'marked';
      sessionId: string;
      student: { id: string; fullName: string; rollNo: string | null };
      status: AttendanceStatus;
      method: 'qr' | 'manual';
      counts: SessionCounts;
    }
  | { type: 'session'; sessionId: string; status: Session['status']; closesAt: string };
