import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { getBoss, enqueue, QUEUES, stopBoss, recordRun, work } from "@aihot/backend/jobs/queue";
import { sql, closeDb } from "@aihot/backend/db";

after(async () => { await stopBoss(); await closeDb(); });

test("a failed first database connection does not poison all later queue requests", async () => {
  const original = config.databaseUrl;
  const missing = new URL(original);
  missing.pathname = "/aihot_missing_queue_recovery_test";
  config.databaseUrl = missing.toString();
  try {
    await assert.rejects(getBoss(), /does not exist/);
  } finally {
    config.databaseUrl = original;
  }
  const boss = await getBoss();
  const id = await enqueue(QUEUES.analyze, { articleId: "recovered" });
  assert.ok(id);
  assert.equal((await boss.getJobById<{ articleId: string }>(QUEUES.analyze, id))?.data.articleId, "recovered");
});

test("a returned task failure is recorded as failed without rerunning its side effects", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  let calls = 0;
  const result = { status: "failed", error: "Provider temporarily refused this task" };
  assert.equal(await recordRun("diagnostics.returned-failure", async () => { calls++; return result; }), result);
  assert.equal(calls, 1);
  const [row] = await sql`SELECT id,status,detail FROM job_runs WHERE job='diagnostics.returned-failure' ORDER BY id DESC LIMIT 1`;
  assert.equal(row.status, "failed");
  assert.deepEqual(row.detail, result);
  const logged = JSON.parse(String(logs.mock.calls[0]!.arguments[0]));
  assert.equal(logged.runId, row.id);
  assert.equal(logged.job, "diagnostics.returned-failure");
});

test("queue failures log their job identity and rethrow without logging the payload", async (t) => {
  const boss = await getBoss();
  const registration = t.mock.method(boss, "work", async () => "diagnostics-worker");
  const logs = t.mock.method(console, "error", () => {});
  const failure = new Error("synthetic handler failure");
  let calls = 0;
  await work(boss, QUEUES.extractBody, {}, async () => { if (++calls === 1) throw failure; return "recovered"; });
  const run = registration.mock.calls[0]!.arguments[2] as unknown as (jobs: Array<{ id: string; data: { articleId: string } }>) => Promise<unknown>;
  const job = { id: "diagnostic-job", data: { articleId: "synthetic-private-payload" } };
  await assert.rejects(run([job]), error => error === failure);
  const entry = JSON.parse(String(logs.mock.calls[0]!.arguments[0]));
  assert.equal(entry.jobId, job.id); assert.equal(entry.job, QUEUES.extractBody);
  assert.match(entry.err.stack, /at /);
  assert.ok(!JSON.stringify(entry).includes(job.data.articleId));
  assert.equal(await run([job]), "recovered");
});

test("failed bookkeeping preserves the original task exception and logs both failures", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  const original = new Error("synthetic task failure");
  await sql.unsafe(`CREATE FUNCTION reject_failed_job_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='failed' THEN RAISE EXCEPTION 'failure log unavailable'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_failed_job_log BEFORE UPDATE ON job_runs FOR EACH ROW EXECUTE FUNCTION reject_failed_job_log()");
  try {
    await assert.rejects(recordRun("diagnostics.bookkeeping", async () => { throw original; }), error => error === original);
    const entries = logs.mock.calls.map(c => JSON.parse(String(c.arguments[0])));
    assert.equal(entries[0].err.message, original.message);
    assert.match(entries[0].err.stack, /at /);
    assert.equal(entries[1].msg, "scheduled task failure recording failed");
    assert.equal(entries[1].runId, entries[0].runId);
    assert.equal(entries[1].err.code, "P0001");
  } finally {
    await sql.unsafe("DROP TRIGGER reject_failed_job_log ON job_runs; DROP FUNCTION reject_failed_job_log()");
  }
  assert.equal(await recordRun("diagnostics.recovered", async () => 42), 42);
});
