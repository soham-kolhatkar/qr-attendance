import type { DbOrTx } from '../db/client.js';
import { auditLogs } from '../db/schema.js';
import { requestContext } from './request-context.js';

export type AuditEntry = {
  instituteId: string | null;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  ip?: string;
};

/**
 * Never put secrets (passwords, tokens) in `data`. Changes made through an API key are
 * tagged with it (the actor is the admin the key acts for).
 */
export async function writeAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  const apiKey = requestContext()?.apiKey;
  await db.insert(auditLogs).values(apiKey ? { ...entry, data: { ...entry.data, viaApiKey: apiKey } } : entry);
}
