import pg from "pg";
import crypto from "node:crypto";
import { TEMPLATE_DB, adminUrl, dispatcherUrl, workerUrl } from "./constants";

export interface TestDb {
  name: string;
  /** Superuser. Stands in for the migration owner and the server's secret key. */
  admin: pg.Pool;
  /** The job runner's login: powerless until scoped to one person. */
  worker: pg.Pool;
  /** The tick's login: three functions and no tables. */
  dispatcher: pg.Pool;
  close(): Promise<void>;
}

/** A fresh database cloned from the migrated template, for one test file. */
export async function createTestDb(): Promise<TestDb> {
  const name = "t_" + crypto.randomBytes(6).toString("hex");
  const root = new pg.Client({ connectionString: adminUrl("postgres") });
  await root.connect();
  // Cloning needs the template to have no open connections; retry briefly if
  // another test file is cloning at the same moment.
  for (let attempt = 0; ; attempt++) {
    try {
      await root.query(`create database ${name} template ${TEMPLATE_DB}`);
      break;
    } catch (e) {
      if (attempt >= 40 || (e as { code?: string }).code !== "55006") throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await root.end();

  const admin = new pg.Pool({ connectionString: adminUrl(name), max: 4 });
  // One connection each: the harshest setting for state leaking between people.
  const worker = new pg.Pool({ connectionString: workerUrl(name), max: 1 });
  const dispatcher = new pg.Pool({ connectionString: dispatcherUrl(name), max: 1 });
  return {
    name, admin, worker, dispatcher,
    async close() {
      await Promise.all([admin.end(), worker.end(), dispatcher.end()]);
      const r = new pg.Client({ connectionString: adminUrl("postgres") });
      await r.connect();
      await r.query(`drop database if exists ${name} with (force)`);
      await r.end();
    },
  };
}

/** Adds an open invitation, as the server would with its secret key. */
export async function invite(db: TestDb, email: string): Promise<void> {
  await db.admin.query("insert into invites (email, token_hash) values ($1, $2)", [
    email.toLowerCase(), crypto.randomBytes(32),
  ]);
}

/**
 * Does what Supabase Auth does when an account is created: ask the hook, then
 * insert the row. Returns the new id, or throws with the hook's message.
 */
export async function signUp(db: TestDb, email: string): Promise<string> {
  const verdict = await db.admin.query("select public.hook_before_user_created($1::jsonb) as v", [
    JSON.stringify({ user: { email } }),
  ]);
  const err = verdict.rows[0].v?.error;
  if (err) throw new Error(err.message);
  const r = await db.admin.query("insert into auth.users (email) values ($1) returning id", [email]);
  return r.rows[0].id as string;
}

/** An invited, signed-up person. */
export async function createPerson(db: TestDb, label = "p"): Promise<string> {
  const email = `${label}-${crypto.randomBytes(4).toString("hex")}@people.example`;
  await invite(db, email);
  return signUp(db, email);
}

export async function expectPgError(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}
