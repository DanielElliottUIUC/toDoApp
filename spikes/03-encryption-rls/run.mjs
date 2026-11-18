// Spike 03: envelope encryption with per-user keys on top of row-level security.
// Throwaway prototype, synthetic data only. Starts its own Postgres (the
// embedded-postgres npm package) in a temporary folder and removes it at the
// end. Prints PASS/FAIL per check and exits non-zero on any FAIL.

import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import EmbeddedPostgres from "embedded-postgres";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_URL = "postgres://postgres:spike@localhost:54329/postgres";
const WORKER_URL = "postgres://app_worker:worker@localhost:54329/spike03";

// ---------------------------------------------------------------------------
// Key management stand-in. In production wrap/unwrap are two calls to a KMS and
// the key-encryption key never leaves it. Here it is a random key in memory.
// The user id is bound in as additional authenticated data ("encryption
// context" in KMS terms), so a wrapped key copied onto another user's row will
// not unwrap.
// ---------------------------------------------------------------------------
const KEK = crypto.randomBytes(32);
const kms = {
  wrap(dek, userId) {
    return seal(KEK, dek, `dek|${userId}`);
  },
  unwrap(wrapped, userId) {
    return open(KEK, wrapped, `dek|${userId}`);
  },
};

// AES-256-GCM. Layout: version(1) | nonce(12) | tag(16) | ciphertext.
function seal(key, plaintext, aad) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, c.getAuthTag(), body]);
}
function open(key, blob, aad) {
  if (blob[0] !== 1) throw new Error("unknown ciphertext version");
  const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
}
// Content is bound to its user, table, column and row, so ciphertext cannot be
// moved between rows or columns without failing to decrypt.
const aadFor = (userId, table, column, rowId) => `${userId}|${table}|${column}|${rowId}`;

// ---------------------------------------------------------------------------
// The worker's only way to touch user data: one transaction, scoped to one
// user, as the `authenticated` role. Both settings are transaction-local, so
// they vanish at commit or rollback and cannot leak through a connection pool.
// ---------------------------------------------------------------------------
async function asUser(pool, userId, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// Per-run key access: fetch the caller's wrapped key under RLS, unwrap it, log
// the access. The plain data key lives only in this function's caller's memory.
async function loadDek(client, userId, actor) {
  const r = await client.query("select wrapped_dek from user_keys where user_id = $1", [userId]);
  if (r.rowCount !== 1) throw new Error("no key visible for this user");
  await client.query("insert into audit_log (user_id, actor, action, target) values ($1,$2,$3,$4)", [
    userId, actor, "key.unwrap", "user_keys",
  ]);
  return kms.unwrap(r.rows[0].wrapped_dek, userId);
}

// ---------------------------------------------------------------------------
let stopServer = async () => {};
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}
async function expectError(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

async function main() {
  const server = new EmbeddedPostgres({
    databaseDir: fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-spike03-")),
    user: "postgres", password: "spike", port: 54329, persistent: false,
    onLog: () => {}, onError: () => {},
  });
  await server.initialise();
  await server.start();
  stopServer = () => server.stop();

  // Fresh database each run.
  const admin0 = new pg.Client({ connectionString: ADMIN_URL });
  await admin0.connect();
  console.log("Postgres " + (await admin0.query("show server_version")).rows[0].server_version + "\n");
  await admin0.query("drop database if exists spike03 with (force)");
  await admin0.query("drop role if exists app_worker");
  await admin0.query("drop role if exists authenticated");
  await admin0.query("create database spike03");
  await admin0.end();

  const admin = new pg.Client({ connectionString: ADMIN_URL.replace(/\/postgres$/, "/spike03") });
  await admin.connect();
  await admin.query(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));

  // max: 1 forces every call through the same physical connection, which is
  // the worst case for state leaking between users.
  const worker = new pg.Pool({ connectionString: WORKER_URL, max: 1 });

  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  const SECRET_A = "Call the clinic about the biopsy result";
  const SECRET_B = "Draft resignation letter";

  // --- Sign-up: make a data key per user, store only the wrapped form --------
  for (const u of [A, B]) {
    const dek = crypto.randomBytes(32);
    await asUser(worker, u, (c) =>
      c.query("insert into user_keys (user_id, wrapped_dek, kek_version) values ($1,$2,1)", [u, kms.wrap(dek, u)]));
    dek.fill(0);
  }

  // --- Each user writes one encrypted task ----------------------------------
  const ids = {};
  for (const [u, secret] of [[A, SECRET_A], [B, SECRET_B]]) {
    ids[u] = await asUser(worker, u, async (c) => {
      const dek = await loadDek(c, u, "agent");
      const id = crypto.randomUUID();
      await c.query(
        "insert into tasks (id, user_id, due_at, est_minutes, title_enc) values ($1,$2, now(), 30, $3)",
        [id, u, seal(dek, Buffer.from(secret), aadFor(u, "tasks", "title_enc", id))]);
      await c.query("insert into job_schedule values ($1,'morning', now() - interval '1 minute', false)", [u]);
      return id;
    });
  }

  // 1. Round trip
  const backA = await asUser(worker, A, async (c) => {
    const dek = await loadDek(c, A, "agent");
    const r = await c.query("select id, title_enc from tasks");
    return r.rows.map((row) => open(dek, row.title_enc, aadFor(A, "tasks", "title_enc", row.id)).toString());
  });
  check("worker scoped to A reads and decrypts A's task", backA.length === 1 && backA[0] === SECRET_A);

  // 2. RLS isolation
  const seenByA = await asUser(worker, A, (c) => c.query("select user_id from tasks"));
  check("A sees only A's rows (unfiltered select)", seenByA.rows.every((r) => r.user_id === A) && seenByA.rowCount === 1);
  const aReadsB = await asUser(worker, A, (c) => c.query("select 1 from tasks where user_id = $1", [B]));
  check("A asking for B's rows by id gets nothing", aReadsB.rowCount === 0);
  const aReadsBKey = await asUser(worker, A, (c) => c.query("select 1 from user_keys where user_id = $1", [B]));
  check("A cannot read B's wrapped key", aReadsBKey.rowCount === 0);
  const e1 = await expectError(() => asUser(worker, A, (c) =>
    c.query("insert into tasks (user_id, title_enc) values ($1, $2)", [B, Buffer.from("x")])));
  check("A cannot insert a row owned by B", !!e1 && /row-level security/.test(e1.message), e1?.code);
  const upd = await asUser(worker, A, (c) => c.query("update tasks set status = 'done' where user_id = $1", [B]));
  check("A's update against B's rows changes nothing", upd.rowCount === 0);
  const del = await asUser(worker, A, (c) => c.query("delete from tasks where user_id = $1", [B]));
  check("A's delete against B's rows removes nothing", del.rowCount === 0);

  // 3. Fail closed without a user context
  const bare = await worker.connect();
  const e2 = await expectError(() => bare.query("select * from tasks"));
  check("worker with no user context cannot read tasks at all", !!e2 && e2.code === "42501", e2?.code);
  const e3 = await expectError(() => bare.query("select * from user_keys"));
  check("worker with no user context cannot read keys at all", !!e3 && e3.code === "42501", e3?.code);
  bare.release();
  const noSub = await worker.connect();
  await noSub.query("begin"); await noSub.query("set local role authenticated");
  const empty = await noSub.query("select 1 from tasks");
  await noSub.query("rollback"); noSub.release();
  check("authenticated role with no user id sees zero rows", empty.rowCount === 0);

  // 4. No leakage across a pooled connection (pool size is 1)
  await asUser(worker, A, (c) => c.query("select 1"));
  const after = await worker.connect();
  const who = await after.query("select current_user, current_setting('request.jwt.claims', true) as claims");
  after.release();
  check("user context is gone after the transaction ends",
    who.rows[0].current_user === "app_worker" && !who.rows[0].claims, JSON.stringify(who.rows[0]));

  // 5. Cryptographic separation, independent of RLS (simulates a stolen dump)
  const dump = await admin.query("select user_id, wrapped_dek from user_keys");
  const tasksDump = await admin.query("select id, user_id, title_enc from tasks");
  const raw = Buffer.concat(tasksDump.rows.map((r) => r.title_enc)).toString("latin1");
  check("database dump contains no plaintext", !raw.includes("clinic") && !raw.includes("resignation"));
  const wrappedA = dump.rows.find((r) => r.user_id === A).wrapped_dek;
  const wrappedB = dump.rows.find((r) => r.user_id === B).wrapped_dek;
  const rowB = tasksDump.rows.find((r) => r.user_id === B);
  const dekA = kms.unwrap(wrappedA, A);
  const e4 = await expectError(async () => open(dekA, rowB.title_enc, aadFor(B, "tasks", "title_enc", rowB.id)));
  check("A's data key cannot decrypt B's content", !!e4);
  const e5 = await expectError(async () => kms.unwrap(wrappedB, A));
  check("B's wrapped key presented as A's will not unwrap", !!e5);
  const rowA = tasksDump.rows.find((r) => r.user_id === A);
  const e6 = await expectError(async () => open(dekA, rowA.title_enc, aadFor(A, "tasks", "title_enc", crypto.randomUUID())));
  check("ciphertext moved to another row fails to decrypt", !!e6);
  const e7 = await expectError(async () => open(dekA, rowA.title_enc, aadFor(A, "tasks", "notes_enc", rowA.id)));
  check("ciphertext moved to another column fails to decrypt", !!e7);
  const tampered = Buffer.from(rowA.title_enc); tampered[tampered.length - 1] ^= 1;
  const e8 = await expectError(async () => open(dekA, tampered, aadFor(A, "tasks", "title_enc", rowA.id)));
  check("tampered ciphertext is rejected", !!e8);

  // 6. Dispatcher: ids only, and only through the function
  const due = await worker.query("select * from due_users('morning', now())");
  check("dispatcher gets both due user ids", due.rowCount === 2 && Object.keys(due.rows[0]).join() === "user_id");
  const e9 = await expectError(() => worker.query("select * from job_schedule"));
  check("dispatcher cannot read the schedule table directly", !!e9 && e9.code === "42501", e9?.code);

  // 7. Audit log: every key unwrap was recorded, and the log is append-only
  const logA = await asUser(worker, A, (c) => c.query("select action, actor from audit_log"));
  check("each key unwrap for A is in A's audit log", logA.rowCount === 2 && logA.rows.every((r) => r.action === "key.unwrap"),
    `${logA.rowCount} entries`);
  const e10 = await expectError(() => asUser(worker, A, (c) => c.query("delete from audit_log")));
  check("audit log entries cannot be deleted", !!e10 && e10.code === "42501", e10?.code);
  const e11 = await expectError(() => asUser(worker, A, (c) => c.query("update audit_log set action = 'x'")));
  check("audit log entries cannot be edited", !!e11 && e11.code === "42501", e11?.code);
  const e12 = await expectError(() => asUser(worker, A, (c) =>
    c.query("insert into audit_log (user_id, actor, action) values ($1,'agent','forged')", [B])));
  check("A cannot write into B's audit log", !!e12 && /row-level security/.test(e12.message));
  const e13 = await expectError(() => asUser(worker, A, (c) =>
    c.query("update user_keys set wrapped_dek = $1 where user_id = $2", [Buffer.from("x"), A])));
  check("a wrapped key cannot be overwritten in place", !!e13 && e13.code === "42501", e13?.code);

  // 8. Every table in the public schema has RLS enabled and forced
  const rls = await admin.query(`select relname, relrowsecurity, relforcerowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`);
  check("every public table has RLS enabled and forced",
    rls.rowCount === 4 && rls.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity));

  await worker.end();
  await admin.end();
  await stopServer();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(async (e) => {
  console.error("spike crashed:", e.message);
  await stopServer().catch(() => {});
  process.exit(2);
});
