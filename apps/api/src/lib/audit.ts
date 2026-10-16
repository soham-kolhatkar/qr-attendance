import type { DbOrTx } from '../db/client.js';
import { auditLogs } from '../db/schema.js';

export type AuditEntry = {
  instituteId: string | null;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  ip?: string;
};

/** Never put secrets (passwords, tokens) in `data`. */
export async function writeAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values(entry);
}
