// Prepares the hosted database for the app. Run from the repository root:
//
//   node --env-file=.env scripts/setup-database.mjs
//
// It reads SUPABASE_DB_URL, then:
//   1. applies any migrations the database has not seen;
//   2. gives the job runner's and the tick's database roles a login and a
//      fresh random password, and writes their connection strings to .env;
//   3. makes a development-only top key if .env has none;
//   4. checks that the roles behave as the design requires.
//
// Safe to run again. Step 2 rotates the two passwords each time. It prints
// what it did and never a password, key or connection string.

import path from "node:path";
import {
  applyMigrations, newLocalKek, repoRoot, roleUrl, setRolePasswords, verifyDatabase,
} from "./lib/database-setup.mjs";
import { readEnvFile, writeEnvEntries } from "./lib/env-file.mjs";

const envFile = path.join(repoRoot, ".env");
const adminUrl = process.env.SUPABASE_DB_URL;
if (!adminUrl) {
  console.error("SUPABASE_DB_URL is not set. See docs/owner-setup.md, step 3.");
  process.exit(1);
}

console.log("1. Applying migrations");
const pushed = applyMigrations(adminUrl);
console.log(pushed ? pushed.split("\n").map((l) => "   " + l).join("\n") : "   nothing to apply");

console.log("2. Setting logins for app_worker and app_dispatcher");
const passwords = await setRolePasswords(adminUrl);
const entries = {
  APP_WORKER_DATABASE_URL: roleUrl(adminUrl, "app_worker", passwords.app_worker),
  APP_DISPATCHER_DATABASE_URL: roleUrl(adminUrl, "app_dispatcher", passwords.app_dispatcher),
};

console.log("3. Development key");
if (readEnvFile(envFile).LOCAL_KEK_BASE64) {
  console.log("   LOCAL_KEK_BASE64 already set; left as it is");
} else {
  entries.LOCAL_KEK_BASE64 = newLocalKek();
  console.log("   made a new LOCAL_KEK_BASE64");
}
writeEnvEntries(envFile, entries);
console.log("   wrote to .env: " + Object.keys(entries).join(", "));

console.log("4. Checking the roles");
const results = await verifyDatabase({
  workerUrl: entries.APP_WORKER_DATABASE_URL,
  dispatcherUrl: entries.APP_DISPATCHER_DATABASE_URL,
});
for (const r of results) console.log(`   ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exitCode = failed ? 1 : 0;
