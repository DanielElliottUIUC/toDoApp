// The "what your assistant did" log. Append-only, one per person, and kept in
// the app's own database so the person can always read it.
//
// An entry says who did what to which thing. It never holds content: `meta`
// is for ids, counts and names of fields, and is checked before it is written.

import type { UserDb } from "./db/user-context";

export type Actor = "user" | "agent" | "operator" | "system";

export interface AuditEntry {
  actor: Actor;
  /** Dotted verb, for example "job.started" or "credential.saved". */
  action: string;
  /** Table or kind of thing acted on. */
  target?: string;
  targetId?: string;
  meta?: Record<string, string | number | boolean | null>;
  /** The id of the entry this one reverses, when it is an undo. */
  undoOf?: number;
}

const MAX_META_STRING = 64;

/** Refuses anything that could be content: nested values and long strings. */
function checkMeta(meta: AuditEntry["meta"]): void {
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value !== null && typeof value === "object") {
      throw new Error(`audit meta "${key}" must be a plain value`);
    }
    if (typeof value === "string" && value.length > MAX_META_STRING) {
      throw new Error(`audit meta "${key}" is too long to be an id or a name; content does not belong in the audit log`);
    }
  }
}

export async function audit(db: UserDb, entry: AuditEntry): Promise<number> {
  checkMeta(entry.meta);
  const r = await db.query(
    `insert into audit_log (user_id, actor, action, target, target_id, meta, undo_of)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [db.userId, entry.actor, entry.action, entry.target ?? null, entry.targetId ?? null,
     JSON.stringify(entry.meta ?? {}), entry.undoOf ?? null],
  );
  return Number(r.rows[0].id);
}
