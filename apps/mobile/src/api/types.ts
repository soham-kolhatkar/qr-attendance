import type { paths } from './schema';

type JsonOf<R> = R extends { content: { 'application/json': infer B } } ? B : never;
type Success<R> = R extends { 200: infer A } ? A : R extends { 201: infer B } ? B : never;

/** The JSON body of a successful response, e.g. `Ok<'/v1/me', 'get'>`. */
export type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { responses: infer R }
  ? JsonOf<Success<R>>
  : never;

export type Me = Ok<'/v1/me', 'get'>;
export type MyPhones = Ok<'/v1/devices/mine', 'get'>;
export type Device = NonNullable<MyPhones['active']>;
export type MyAttendance = Ok<'/v1/attendance/mine', 'get'>;
export type ScanResult = Ok<'/v1/attendance/scan', 'post'>;
