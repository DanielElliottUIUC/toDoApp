// The hard constraint, made mechanical: row-level security on every table, and
// no person can read or change another person's rows.
//
// Adding a table without adding it to `ownedTables` or `sharedTables` below
// fails the first test, so a table cannot ship without an isolation test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { withUser } from "../src/db/user-context";
import { createPerson, createTestDb, expectPgError, type TestDb } from "./helpers/db";

let db: TestDb;
let A: string;
let B: string;

/** What a person may do to their own rows in each table they own. */
interface Owned {
  /** Column values for a valid new row owned by `userId`. Null: the person cannot insert. */
  row: ((userId: string) => Record<string, unknown>) | null;
  /** A column the person may update on their own row, with a new value. Null: no updates. */
  update: [string, unknown] | null;
  /** Whether the person may delete their own row. */
  canDelete: boolean;
}

const bytes = () => crypto.randomBytes(16);

const ownedTables: Record<string, Owned> = {
  profiles: { row: null, update: ["agent_paused", true], canDelete: false },
  user_keys: {
    row: (u) => ({ user_id: u, wrapped_dek: bytes(), kek_id: "test" }),
    update: null, canDelete: false,
  },
  provider_credentials: {
    row: (u) => ({ user_id: u, provider: "anthropic", key_enc: bytes(), key_last4: "abcd" }),
    update: ["key_last4", "wxyz"], canDelete: true,
  },
  audit_log: {
    row: (u) => ({ user_id: u, actor: "user", action: "test.entry" }),
    update: null, canDelete: false,
  },
  job_schedules: {
    row: (u) => ({ user_id: u, job_type: "test_job", local_time: "09:00", next_run_at: new Date() }),
    update: ["enabled", false], canDelete: true,
  },
  job_runs: { row: null, update: ["status", "running"], canDelete: false },
  message_prefs: { row: null, update: ["soft_cap", 4], canDelete: false },
  outbound_messages: {
    row: (u) => ({ user_id: u, delivery: "batch", message_type: "test", body_enc: bytes() }),
    update: ["status", "dropped"], canDelete: false,
  },
  spend_events: {
    row: (u) => ({ user_id: u, job_type: "test", model: "claude-haiku-5-5", cost_usd: 0.01 }),
    update: null, canDelete: false,
  },
};

/** Tables with no owner column, and the rule that applies to each. */
const sharedTables: Record<string, string> = {
  invites: "no person can read or write it",
  model_prices: "every signed-in person can read it and nobody can write it",
};

const insertSql = (table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row);
  return {
    text: `insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    values: Object.values(row),
  };
};

beforeAll(async () => {
  db = await createTestDb();
  A = await createPerson(db, "a");
  B = await createPerson(db, "b");
  // Give both people a row in every owned table, written as the server would.
  for (const u of [A, B]) {
    for (const [table, spec] of Object.entries(ownedTables)) {
      if (spec.row) {
        const q = insertSql(table, spec.row(u));
        await db.admin.query(q.text, q.values);
      }
    }
    await db.admin.query(
      "insert into job_runs (user_id, job_type, scheduled_for, idempotency_key) values ($1, 'test_job', now(), $2)",
      [u, `${u}:seed`],
    );
  }
});
afterAll(async () => db.close());

describe("every table", () => {
  it("is covered by an isolation rule in this file", async () => {
    const r = await db.admin.query("select tablename from pg_tables where schemaname = 'public' order by 1");
    const actual = r.rows.map((x) => x.tablename as string);
    expect(actual).toEqual([...Object.keys(ownedTables), ...Object.keys(sharedTables)].sort());
  });

  it("has row-level security enabled and forced", async () => {
    const r = await db.admin.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(r.rowCount).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row, `table ${row.relname}`).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("gives the signed-out role no privilege on any table or view", async () => {
    const r = await db.admin.query(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon'`,
    );
    expect(r.rows).toEqual([]);
  });

  it("with an owner column refers every policy to the signed-in person", async () => {
    const r = await db.admin.query(
      `select tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as rule, roles
       from pg_policies where schemaname = 'public'`,
    );
    for (const p of r.rows) {
      expect(p.roles, `${p.tablename}.${p.policyname}`).toBe("{authenticated}");
      if (p.tablename in ownedTables) {
        expect(p.rule, `${p.tablename}.${p.policyname}`).toMatch(/user_id = \( ?SELECT auth\.uid\(\)/i);
      }
    }
  });

  it("views run with the reader's own permissions", async () => {
    const r = await db.admin.query(
      `select c.relname, coalesce(c.reloptions::text, '') as opts
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v'`,
    );
    for (const v of r.rows) expect(v.opts, `view ${v.relname}`).toContain("security_invoker=true");
  });
});

describe.each(Object.entries(ownedTables))("%s", (table, spec) => {
  it("shows a person only their own rows", async () => {
    const mine = await withUser(db.worker, A, (c) => c.query(`select user_id from ${table}`));
    expect(mine.rowCount).toBeGreaterThan(0);
    expect(mine.rows.every((r) => r.user_id === A)).toBe(true);
  });

  it("returns nothing when asked for another person's rows by id", async () => {
    const theirs = await withUser(db.worker, A, (c) => c.query(`select 1 from ${table} where user_id = $1`, [B]));
    expect(theirs.rowCount).toBe(0);
  });

  it("refuses a row written in another person's name", async () => {
    const row = spec.row ? spec.row(B) : { user_id: B };
    const q = insertSql(table, table === "job_schedules" ? { ...row, job_type: "forged" } : row);
    const err = await expectPgError(() => withUser(db.worker, A, (c) => c.query(q.text, q.values)));
    // Either row-level security refuses the row, or the person has no insert right at all.
    expect(err.code === "42501" || /row-level security/.test(err.message), err.message).toBe(true);
  });

  it("does not let a person change another person's rows", async () => {
    if (spec.update) {
      const [col, value] = spec.update;
      const r = await withUser(db.worker, A, (c) =>
        c.query(`update ${table} set ${col} = $1 where user_id = $2`, [value, B]));
      expect(r.rowCount).toBe(0);
    } else {
      const err = await expectPgError(() => withUser(db.worker, A, (c) =>
        c.query(`update ${table} set user_id = user_id where user_id = $1`, [B])));
      expect(err.code).toBe("42501");
    }
  });

  it("does not let a person delete another person's rows", async () => {
    if (spec.canDelete) {
      const r = await withUser(db.worker, A, (c) => c.query(`delete from ${table} where user_id = $1`, [B]));
      expect(r.rowCount).toBe(0);
    } else {
      const err = await expectPgError(() => withUser(db.worker, A, (c) =>
        c.query(`delete from ${table} where user_id = $1`, [B])));
      expect(err.code).toBe("42501");
    }
    const still = await db.admin.query(`select 1 from ${table} where user_id = $1`, [B]);
    expect(still.rowCount).toBeGreaterThan(0);
  });

  it("cannot have a row re-assigned to another person", async () => {
    const err = await expectPgError(() => withUser(db.worker, A, (c) =>
      c.query(`update ${table} set user_id = $1 where user_id = $2`, [B, A])));
    expect(err.code === "42501" || /row-level security/.test(err.message), err.message).toBe(true);
  });
});

describe("shared tables", () => {
  it("invites cannot be read or written by any person", async () => {
    const read = await expectPgError(() => withUser(db.worker, A, (c) => c.query("select * from invites")));
    expect(read.code).toBe("42501");
    const write = await expectPgError(() => withUser(db.worker, A, (c) =>
      c.query("insert into invites (email, token_hash) values ('x@people.example', $1)", [bytes()])));
    expect(write.code).toBe("42501");
  });

  it("model prices can be read by any person and written by none", async () => {
    const read = await withUser(db.worker, A, (c) => c.query("select model from model_prices"));
    expect(read.rowCount).toBeGreaterThanOrEqual(4);
    const write = await expectPgError(() => withUser(db.worker, A, (c) =>
      c.query("update model_prices set input_per_mtok = 0")));
    expect(write.code).toBe("42501");
  });

  it("the spend meter shows a person only their own spend", async () => {
    const r = await withUser(db.worker, A, (c) => c.query("select user_id from spend_daily"));
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].user_id).toBe(A);
  });
});

describe("the worker's login", () => {
  it("can read nothing until it is scoped to a person", async () => {
    for (const table of [...Object.keys(ownedTables), ...Object.keys(sharedTables)]) {
      const err = await expectPgError(() => db.worker.query(`select * from ${table}`));
      expect(err.code, table).toBe("42501");
    }
  });

  it("sees zero rows as a signed-in role with no person id", async () => {
    const c = await db.worker.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      for (const table of Object.keys(ownedTables)) {
        expect((await c.query(`select 1 from ${table}`)).rowCount, table).toBe(0);
      }
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("keeps no person's context after the transaction ends", async () => {
    await withUser(db.worker, A, (c) => c.query("select 1"));
    const r = await db.worker.query(
      "select current_user as who, coalesce(current_setting('request.jwt.claims', true), '') as claims");
    expect(r.rows[0]).toEqual({ who: "app_worker", claims: "" });
  });

  it("drops the person's context when the work throws", async () => {
    await expect(withUser(db.worker, A, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const r = await db.worker.query("select current_user as who");
    expect(r.rows[0].who).toBe("app_worker");
  });

  it("refuses anything that is not a person's id", async () => {
    await expect(withUser(db.worker, "'; drop table profiles; --", async () => 1)).rejects.toThrow();
  });

  it("cannot call the dispatcher's or the server's functions", async () => {
    for (const call of [
      "select * from claim_due_jobs(now())",
      "select mark_job_rejected(gen_random_uuid(), 'x')",
      "select * from invite_for_token('\\x00')",
      "select hook_before_user_created('{}'::jsonb)",
    ]) {
      const bare = await expectPgError(() => db.worker.query(call));
      expect(bare.code, call).toBe("42501");
      const scoped = await expectPgError(() => withUser(db.worker, A, (c) => c.query(call)));
      expect(scoped.code, call).toBe("42501");
    }
  });
});

describe("a person's own limits", () => {
  it("cannot make themselves an operator", async () => {
    const err = await expectPgError(() => withUser(db.worker, A, (c) =>
      c.query("update profiles set is_operator = true where user_id = $1", [A])));
    expect(err.code).toBe("42501");
  });

  it("cannot edit or delete their own audit log", async () => {
    const upd = await expectPgError(() => withUser(db.worker, A, (c) => c.query("update audit_log set action = 'x'")));
    expect(upd.code).toBe("42501");
    const del = await expectPgError(() => withUser(db.worker, A, (c) => c.query("delete from audit_log")));
    expect(del.code).toBe("42501");
  });

  it("cannot overwrite their wrapped data key in place", async () => {
    const err = await expectPgError(() => withUser(db.worker, A, (c) =>
      c.query("update user_keys set wrapped_dek = $1", [bytes()])));
    expect(err.code).toBe("42501");
  });

  it("cannot set an unknown time zone", async () => {
    const err = await expectPgError(() => withUser(db.worker, A, (c) =>
      c.query("update profiles set timezone = 'Mars/Olympus' where user_id = $1", [A])));
    expect(err.code).toBe("22023");
  });
});
