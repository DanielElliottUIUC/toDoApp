// The steps that prepare a database for the app, written as functions so the
// same code runs against the hosted Supabase project and, in the tests,
// against a throwaway local Postgres.
//
// Nothing here prints a password, a key or a connection string.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const APP_ROLES = ["app_worker", "app_dispatcher"];

/** The Supabase command-line tool installed in this repository. */
function supabaseCli() {
  const script = path.join(repoRoot, "node_modules", "supabase", "dist", "supabase.js");
  if (!fs.existsSync(script)) throw new Error("the Supabase CLI is not installed; run npm install");
  return script;
}

/**
 * Applies every migration in supabase/migrations that the database has not
 * seen, using the Supabase CLI so the project's own migration history is kept.
 * Safe to run again: applied migrations are skipped.
 */
export function applyMigrations(adminUrl) {
  const r = spawnSync(process.execPath, [supabaseCli(), "db", "push", "--db-url", adminUrl, "--yes"], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true,
  });
  // The tool echoes the connection string in some messages; never pass that on.
  const scrub = (s) => (s ?? "").split(adminUrl).join("<database url>").replace(/postgres(ql)?:\/\/\S+/g, "<database url>");
  const output = scrub(r.stdout) + scrub(r.stderr);
  if (r.status !== 0) throw new Error("applying migrations failed:\n" + output.trim());
  return output.trim();
}

/**
 * Gives the two app roles a login and a fresh random password each. Run again
 * to rotate them. Returns the passwords for the caller to store; they are not
 * kept anywhere else.
 */
export async function setRolePasswords(adminUrl) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const passwords = {};
    for (const role of APP_ROLES) {
      const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
      if (exists.rowCount !== 1) throw new Error(`role ${role} does not exist; apply the migrations first`);
      // Letters and digits only, so the password needs no escaping in a URL.
      const password = crypto.randomBytes(32).toString("base64url").replace(/[-_]/g, "x");
      const stmt = await client.query("select format('alter role %I with login password %L', $1::text, $2::text) as sql", [role, password]);
      await client.query(stmt.rows[0].sql);
      passwords[role] = password;
    }
    return passwords;
  } finally {
    await client.end();
  }
}

/**
 * The connection string for an app role, derived from the admin one.
 *
 * Supabase's pooler names a login as "<role>.<project ref>" and offers two
 * ports: 5432 keeps one database session per client, 6543 hands a connection
 * out per transaction. The app roles do all their work inside single
 * transactions, so they use 6543.
 */
export function roleUrl(adminUrl, role, password) {
  const u = new URL(adminUrl);
  const dot = u.username.indexOf(".");
  u.username = dot === -1 ? role : role + u.username.slice(dot);
  u.password = password;
  if (u.hostname.endsWith(".pooler.supabase.com")) u.port = "6543";
  return u.toString();
}

/** A fresh top key for the development-only local key service. */
export function newLocalKek() {
  return crypto.randomBytes(32).toString("base64");
}

/**
 * Checks, against a live database, the properties the design depends on.
 * Creates nothing and reads no person's data. Returns one entry per check.
 */
export async function verifyDatabase({ workerUrl, dispatcherUrl }) {
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail ?? "" });
    } catch (e) {
      results.push({ name, ok: false, detail: e.code ? `${e.code}: ${e.message}` : e.message });
    }
  };
  const refused = async (client, sql) => {
    try {
      await client.query(sql);
    } catch (e) {
      if (e.code === "42501") return;
      throw e;
    }
    throw new Error("was allowed");
  };

  const worker = new pg.Pool({ connectionString: workerUrl, max: 1 });
  const dispatcher = new pg.Pool({ connectionString: dispatcherUrl, max: 1 });
  try {
    await check("the job runner's login connects", async () => {
      const r = await worker.query("select current_user as who");
      if (r.rows[0].who !== "app_worker") throw new Error("connected as " + r.rows[0].who);
    });
    await check("the job runner's login cannot bypass row-level security", async () => {
      const r = await worker.query("select rolbypassrls, rolsuper from pg_roles where rolname = current_user");
      if (r.rows[0].rolbypassrls || r.rows[0].rolsuper) throw new Error("the role can bypass row-level security");
    });
    await check("unscoped, it can read no table", async () => {
      const tables = await worker.query("select tablename from pg_tables where schemaname = 'public' order by 1");
      if (tables.rowCount === 0) throw new Error("no tables found; were the migrations applied?");
      for (const t of tables.rows) await refused(worker, `select 1 from public."${t.tablename}" limit 1`);
      return `${tables.rowCount} tables`;
    });
    await check("scoped to a person who does not exist, it sees zero rows", async () => {
      const c = await worker.connect();
      try {
        await c.query("begin");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: crypto.randomUUID(), role: "authenticated" }),
        ]);
        const uid = await c.query("select auth.uid() as uid");
        if (!uid.rows[0].uid) throw new Error("auth.uid() did not pick up the person's id");
        for (const table of ["profiles", "user_keys", "audit_log", "job_runs", "outbound_messages", "spend_events"]) {
          const r = await c.query(`select 1 from public.${table} limit 1`);
          if (r.rowCount !== 0) throw new Error(`${table} returned a row`);
        }
      } finally {
        await c.query("rollback").catch(() => {});
        c.release();
      }
    });
    await check("the person's context is gone once the transaction ends", async () => {
      // Run several times: through a pooler each query may land on a different server connection.
      for (let i = 0; i < 5; i++) {
        const r = await worker.query(
          "select current_user as who, coalesce(current_setting('request.jwt.claims', true), '') as claims");
        if (r.rows[0].who !== "app_worker" || r.rows[0].claims !== "") throw new Error("context leaked: " + r.rows[0].who);
      }
    });
    await check("the tick's login connects and can read no table", async () => {
      const r = await dispatcher.query("select current_user as who");
      if (r.rows[0].who !== "app_dispatcher") throw new Error("connected as " + r.rows[0].who);
      for (const table of ["profiles", "job_schedules", "job_runs", "invites"]) await refused(dispatcher, `select 1 from public.${table} limit 1`);
    });
    await check("the tick's login cannot become a person", async () => {
      await refused(dispatcher, "set role authenticated");
    });
    await check("the tick's login can ask who is due", async () => {
      const r = await dispatcher.query("select * from public.claim_due_jobs(now(), 1)");
      return `${r.rowCount} due`;
    });
    await check("the job runner's login cannot call the tick's functions", async () => {
      await refused(worker, "select * from public.claim_due_jobs(now(), 1)");
    });
  } finally {
    await Promise.all([worker.end(), dispatcher.end()]);
  }
  return results;
}
