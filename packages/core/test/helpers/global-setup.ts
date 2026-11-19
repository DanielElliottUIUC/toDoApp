// Starts one throwaway Postgres for the whole test run, builds a template
// database from the Supabase stand-ins plus the real migrations, and removes
// everything afterwards. Each test file clones the template (see db.ts).

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_PASSWORD, PORT, ROLE_PASSWORD, TEMPLATE_DB, adminUrl } from "./constants";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

export default async function setup(): Promise<() => Promise<void>> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-test-pg-"));
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: ADMIN_PASSWORD,
    port: PORT,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();

  try {
    const root = new pg.Client({ connectionString: adminUrl("postgres") });
    await root.connect();
    await root.query(`create database ${TEMPLATE_DB}`);
    await root.end();

    const tpl = new pg.Client({ connectionString: adminUrl(TEMPLATE_DB) });
    await tpl.connect();
    await tpl.query(fs.readFileSync(path.join(here, "supabase-shim.sql"), "utf8"));
    const dir = path.join(repoRoot, "supabase", "migrations");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await tpl.query(fs.readFileSync(path.join(dir, file), "utf8"));
    }
    // In production these passwords come from the environment and are set by hand.
    await tpl.query(`alter role app_worker login password '${ROLE_PASSWORD}'`);
    await tpl.query(`alter role app_dispatcher login password '${ROLE_PASSWORD}'`);
    await tpl.end();
  } catch (e) {
    await server.stop();
    throw e;
  }

  return async () => {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
}
