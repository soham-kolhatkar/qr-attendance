import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { as, expectStatus, login, loginStudent, setupClass, signedScan, type Tokens, useTestApp } from './helpers.js';

const ctx = useTestApp();

type SseEvent = { event: string; data: any };

/** Connects like a browser would (fetch + Authorization header) and reads events one at a time. */
async function openStream(url: string, tokens: Tokens) {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function next(timeoutMs = 5000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(':')) continue; // keep-alive ping
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null');
        return { event, data };
      }
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no event within timeout')), deadline - Date.now())),
      ]);
      if (chunk.done) throw new Error('stream ended');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  return { res, next, close: () => controller.abort() };
}

async function serve() {
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
}

describe('live headcount stream', () => {
  it('sends a snapshot, then every scan, manual mark and the close as they happen', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const prof = as(ctx.app, c.profTokens);
    const session = expectStatus(await prof.post('/v1/sessions', { offeringId: c.offering.id }), 201);
    const base = await serve();
    const stream = await openStream(`${base}/v1/sessions/${session.id}/live`, c.profTokens);
    try {
      expect(stream.res.headers.get('content-type')).toContain('text/event-stream');
      const snapshot = await stream.next();
      expect(snapshot).toMatchObject({ event: 'snapshot', data: { id: session.id, counts: { present: 0, total: 3 } } });

      const qr = expectStatus(await prof.get(`/v1/sessions/${session.id}/qr`), 200).payload;
      expectStatus(await signedScan(ctx, await loginStudent(ctx.app, 'ca02'), qr), 200);
      const scanned = await stream.next();
      expect(scanned).toMatchObject({
        event: 'marked',
        data: { student: { fullName: 'Student ca02', rollNo: '2' }, status: 'present', method: 'qr', counts: { present: 1, absent: 2 } },
      });

      await prof.post(`/v1/sessions/${session.id}/mark`, { studentIds: [c.students.a3], status: 'present', reason: 'No phone' });
      expect(await stream.next()).toMatchObject({ event: 'marked', data: { method: 'manual', counts: { present: 2 } } });

      await prof.post(`/v1/sessions/${session.id}/close`);
      expect(await stream.next()).toMatchObject({ event: 'session', data: { status: 'closed' } });
    } finally {
      stream.close();
    }
  });

  it('does not hold up a server shutdown', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await as(ctx.app, c.profTokens).post('/v1/sessions', { offeringId: c.offering.id }), 201);
    const stream = await openStream(`${await serve()}/v1/sessions/${session.id}/live`, c.profTokens);
    await stream.next(); // snapshot: the stream is up
    const started = Date.now();
    await ctx.app.close();
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(stream.next(500)).rejects.toThrow('stream ended');
  });

  it('only streams sessions the caller may see', async () => {
    const c = await setupClass(ctx.app, ctx.db);
    const session = expectStatus(await as(ctx.app, c.profTokens).post('/v1/sessions', { offeringId: c.offering.id }), 201);
    const base = await serve();
    const other = await login(ctx.app, { instituteCode: 'ALPHA', username: 'prof.b' });
    const res = await fetch(`${base}/v1/sessions/${session.id}/live`, { headers: { authorization: `Bearer ${other.accessToken}` } });
    expect(res.status).toBe(404);
    const student = await loginStudent(ctx.app, 'ca01');
    const asStudent = await fetch(`${base}/v1/sessions/${session.id}/live`, { headers: { authorization: `Bearer ${student.accessToken}` } });
    expect(asStudent.status).toBe(403);
  });
});
