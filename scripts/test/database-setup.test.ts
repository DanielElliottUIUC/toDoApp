// Runs the hosted-database setup end to end against a throwaway Postgres that
// has only the Supabase stand-ins in it, which is the state a new Supabase
// project is in before the app's first migration.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error plain JavaScript module without type declarations
import { applyMigrations, newLocalKek, repoRoot, roleUrl, setRolePasswords, verifyDatabase } from "../lib/database-setup.mjs";
// @ts-expect-error plain JavaScript module without type declarations
import { parseEnv, setEnvEntries } from "../lib/env-file.mjs";

const PORT = 54341;
const adminUrl = `postgres://postgres:setup-test@localhost:${PORT}/postgres`;

let server: EmbeddedPostgres;
let dataDir: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-setup-test-"));
  server = new EmbeddedPostgres({
    databaseDir: dataDir, user: "postgres", password: "setup-test", port: PORT, persistent: false,
    onLog: () => {}, onError: () => {},
  });
  await server.initialise();
  await server.start();
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(fs.readFileSync(path.join(repoRoot, "packages/core/test/helpers/supabase-shim.sql"), "utf8"));
  await c.end();
});
afterAll(async () => {
  await server.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("setting up a database", () => {
  let urls: { workerUrl: string; dispatcherUrl: string };

  it("applies the migrations with the Supabase CLI and records them in its history", async () => {
    applyMigrations(adminUrl);
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    const tables = await c.query("select count(*)::int as n from pg_tables where schemaname = 'public'");
    const history = await c.query("select version from supabase_migrations.schema_migrations order by version");
    await c.end();
    expect(tables.rows[0].n).toBe(11);
    expect(history.rows.map((r) => r.version)).toEqual(["20261118000100"]);
  });

  it("does nothing when run again", () => {
    expect(() => applyMigrations(adminUrl)).not.toThrow();
  });

  it("never passes the connection string on when the tool fails", () => {
    const bad = `postgres://postgres:wrong-password@localhost:${PORT}/postgres`;
    let message = "";
    try { applyMigrations(bad); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("applying migrations failed");
    expect(message).not.toContain("wrong-password");
  });

  it("gives the two roles working logins with fresh passwords", async () => {
    const passwords = await setRolePasswords(adminUrl);
    expect(Object.keys(passwords)).toEqual(["app_worker", "app_dispatcher"]);
    expect(passwords.app_worker).toMatch(/^[A-Za-z0-9]{40,}$/);
    expect(passwords.app_worker).not.toBe(passwords.app_dispatcher);
    urls = {
      workerUrl: roleUrl(adminUrl, "app_worker", passwords.app_worker),
      dispatcherUrl: roleUrl(adminUrl, "app_dispatcher", passwords.app_dispatcher),
    };
    const results = await verifyDatabase(urls);
    expect(results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(9);
  });

  it("rotates the passwords when run again, and the old ones stop working", async () => {
    const old = urls;
    const passwords = await setRolePasswords(adminUrl);
    const stale = await verifyDatabase(old);
    expect(stale[0]).toMatchObject({ ok: false });
    const fresh = await verifyDatabase({
      workerUrl: roleUrl(adminUrl, "app_worker", passwords.app_worker),
      dispatcherUrl: roleUrl(adminUrl, "app_dispatcher", passwords.app_dispatcher),
    });
    expect(fresh.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it("reports a failure instead of passing when a role can do too much", async () => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    await c.query("grant select on public.profiles to app_worker");
    const passwords = await setRolePasswords(adminUrl);
    const results = await verifyDatabase({
      workerUrl: roleUrl(adminUrl, "app_worker", passwords.app_worker),
      dispatcherUrl: roleUrl(adminUrl, "app_dispatcher", passwords.app_dispatcher),
    });
    await c.query("revoke select on public.profiles from app_worker");
    await c.end();
    const failed = results.filter((r: { ok: boolean }) => !r.ok).map((r: { name: string }) => r.name);
    expect(failed).toEqual(["unscoped, it can read no table"]);
  });
});

describe("deriving a role's connection string", () => {
  it("keeps the project reference in the pooler's login name and uses the per-transaction port", () => {
    const admin = "postgresql://postgres.abcdefghijklmnop:admin-pw@aws-0-us-east-2.pooler.supabase.com:5432/postgres";
    expect(roleUrl(admin, "app_worker", "pw123")).toBe(
      "postgresql://app_worker.abcdefghijklmnop:pw123@aws-0-us-east-2.pooler.supabase.com:6543/postgres");
  });
  it("leaves a direct connection's host and port alone", () => {
    expect(roleUrl("postgres://postgres:admin-pw@db.example.test:5432/postgres", "app_dispatcher", "pw"))
      .toBe("postgres://app_dispatcher:pw@db.example.test:5432/postgres");
  });
});

describe("the .env file", () => {
  it("replaces a value in place and appends a missing one, leaving everything else untouched", () => {
    const before = "# comment\nA=1\n\nB=\"two\"\n# trailing\n";
    const after = setEnvEntries(before, { B: "2", C: "3" });
    expect(after).toBe("# comment\nA=1\n\nB=2\n# trailing\nC=3\n");
    expect(parseEnv(after)).toEqual({ A: "1", B: "2", C: "3" });
  });
  it("keeps Windows line endings", () => {
    expect(setEnvEntries("A=1\r\nB=2\r\n", { A: "9" })).toBe("A=9\r\nB=2\r\n");
  });
  it("starts a file that does not exist yet", () => {
    expect(setEnvEntries("", { A: "1" })).toBe("A=1\n");
  });
  it("refuses a value with a line break in it", () => {
    expect(() => setEnvEntries("", { A: "1\nB=2" })).toThrow(/line break/);
  });
  it("makes a 32-byte development key", () => {
    expect(Buffer.from(newLocalKek(), "base64")).toHaveLength(32);
  });
});
