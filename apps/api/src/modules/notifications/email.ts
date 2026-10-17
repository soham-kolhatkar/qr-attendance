import type { FastifyBaseLogger } from 'fastify';

export type Email = { to: { email: string; name: string }; subject: string; text: string; html: string };

/** Sends one email; throws DeliveryError (permanent or not) when it can't. */
export type EmailSender = { send(email: Email): Promise<void> };

/** A failure worth retrying (network, rate limit, provider down) unless `permanent`. */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** "Name <address>" or "address" → parts. */
export function parseSender(from: string): { email: string; name?: string } {
  const match = /^(.*)<(.+)>$/.exec(from.trim());
  return match ? { name: match[1]!.trim().replace(/^"|"$/g, '') || undefined, email: match[2]!.trim() } : { email: from.trim() };
}

/** Brevo's transactional email API (free plan: 300 emails a day, from a verified sender address). */
export function brevoSender(apiKey: string, from: string, fetchFn: typeof fetch = fetch): EmailSender {
  const sender = parseSender(from);
  return {
    async send(email) {
      let res: Response;
      try {
        res = await fetchFn('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender,
            to: [email.to],
            subject: email.subject,
            htmlContent: email.html,
            textContent: email.text,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new DeliveryError(`Brevo unreachable: ${(err as Error).message}`);
      }
      if (res.ok) return;
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      // 4xx other than rate limiting won't get better by retrying (bad address, sender not verified, bad key).
      throw new DeliveryError(`Brevo ${res.status}: ${detail}`, res.status >= 400 && res.status < 500 && res.status !== 429);
    },
  };
}

/** For development: emails go to the server log instead of anyone's inbox. */
export function logSender(log: FastifyBaseLogger): EmailSender {
  return {
    async send(email) {
      log.info({ to: email.to.email, subject: email.subject }, `email (not sent, EMAIL_PROVIDER=log):\n${email.text}`);
    },
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * One plain layout for every email. The body is the notification's text: blank lines
 * separate paragraphs, and lines starting with "• " become a list.
 */
export function renderEmail(input: {
  to: { email: string; name: string };
  title: string;
  body: string;
  institute: string;
  link?: { label: string; url: string };
}): Email {
  const blocks = input.body.split(/\n\s*\n/).map((block) => block.split('\n'));
  const html = blocks
    .map((lines) => {
      const items = lines.filter((l) => l.startsWith('• '));
      const text = lines.filter((l) => !l.startsWith('• '));
      return [
        text.length ? `<p style="margin:0 0 12px">${text.map(escapeHtml).join('<br>')}</p>` : '',
        items.length
          ? `<ul style="margin:0 0 12px;padding-left:20px">${items.map((l) => `<li>${escapeHtml(l.slice(2))}</li>`).join('')}</ul>`
          : '',
      ].join('');
    })
    .join('');
  const button = input.link
    ? `<p style="margin:20px 0"><a href="${escapeHtml(input.link.url)}" style="background:#4c6ef5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(input.link.label)}</a></p>`
    : '';
  const footer = `Sent by QR Attendance for ${input.institute}.`;
  return {
    to: input.to,
    subject: input.title,
    text: [`Hi ${input.to.name},`, '', input.body, ...(input.link ? ['', `${input.link.label}: ${input.link.url}`] : []), '', '--', footer].join('\n'),
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328;font-size:15px;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:24px">
<h1 style="font-size:19px;margin:0 0 16px">${escapeHtml(input.title)}</h1>
<p style="margin:0 0 12px">Hi ${escapeHtml(input.to.name)},</p>
${html}${button}
<p style="margin:24px 0 0;color:#6a737d;font-size:13px">${escapeHtml(footer)}</p>
</div></body></html>`,
  };
}
