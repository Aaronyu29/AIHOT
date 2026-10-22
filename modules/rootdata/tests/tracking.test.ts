import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";
import { BudgetExceededError, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { tag } from "../../../tests/setup.ts";
import { discoverFundingCandidates, enrichFundingProjects, reserveRootDataCredits, updateFundingProject, syncFundingProjects, type RootDataProvider } from "../tracking.ts";
import { fundingProject, listFundingProjects } from "../publication.ts";
import { RootDataError } from "../client.ts";

after(closeDb);

test("a failed lock or unlock returns the reserved connection and preserves lock acquisition errors", async t => {
  const enabled = process.env.ROOTDATA_ENABLED;
  process.env.ROOTDATA_ENABLED = "false";
  t.after(() => { process.env.ROOTDATA_ENABLED = enabled; });
  for (const acquireFails of [true, false]) {
    let released = 0, queries = 0;
    const failure = new Error(acquireFails ? "lock connection lost" : "unlock connection lost");
    const connection = Object.assign(async () => {
      queries++;
      if (acquireFails || queries > 1) throw failure;
      return [{ locked: true }];
    }, { release: () => { released++; } });
    const mocked = t.mock.method(sql, "reserve", async () => connection as unknown as Awaited<ReturnType<typeof sql.reserve>>);
    try { await assert.rejects(syncFundingProjects(), error => error === failure); }
    finally { mocked.mock.restore(); }
    assert.equal(released, 1);
    assert.equal(queries, acquireFails ? 1 : 2);
  }
});

async function report(title: string) {
  const id = `rd-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, site_fulltext) VALUES (${id}, 'Verified publication', 'rss', false)`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at)
    VALUES (${id}, ${id}, ${id}, ${`https://example.org/${id}`}, ${title}, now(), now(), now())`;
  await sql`INSERT INTO publications (article_id, title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, selected)
    VALUES (${id}, ${title}, 'A publicly available financing report.', ${id}, 'news', ${`https://example.org/${id}`}, now(), now(), now(), now(), true, false)`;
  return id;
}

async function candidate(name: string) {
  const articleId = await report(`${name} raises $10 million in seed funding`);
  await discoverFundingCandidates();
  const [row] = await sql<{ id: number; version: number }[]>`SELECT id, version FROM rootdata_projects WHERE name = ${name}`;
  assert.ok(row);
  return { ...row, articleId };
}

test("unselected public financing reports require review, and withdrawal/correction immediately removes evidence", async () => {
  const item = await candidate(`Alpha${tag()}`);
  assert.equal(await fundingProject(item.id), null);
  await updateFundingProject(item.id, { version: item.version, reason: "Checked original report", publicReason: "Follow the reported product development after financing", reviewStatus: "approved" }, "test-admin");
  const visible = await fundingProject(item.id);
  assert.equal(visible?.evidence[0]?.articleId, item.articleId);
  assert.equal(visible?.profileStatus, "pending");
  assert.equal("reviewStatus" in visible!, false);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${item.articleId}`;
  assert.equal(await fundingProject(item.id), null);
  await sql`UPDATE publications SET visibility = 'public', revision = revision + 1, title = 'Corrected: funding was not completed' WHERE article_id = ${item.articleId}`;
  assert.equal(await fundingProject(item.id), null, "old funding relation is not valid for a corrected report");
  assert.equal((await listFundingProjects()).items.some((p) => p.id === item.id), false);
});

test("missing key sends no provider requests while local discovery still works", async () => {
  process.env.ROOTDATA_ENABLED = "true";
  delete process.env.ROOTDATA_API_KEY;
  const item = await candidate(`NoKey${tag()}`);
  let calls = 0;
  const fail = async (): Promise<never> => { calls++; throw new Error("must not call"); };
  const result = await enrichFundingProjects({ quota: fail, search: fail, project: fail });
  assert.equal(result.skipped, "disabled_or_missing_key");
  assert.equal(calls, 0);
  assert.ok(item.id);
});

test("pending and rejected candidates receive new public updates for automatic reconsideration while paused projects stay paused", async () => {
  for (const state of ["pending", "rejected", "paused"] as const) {
    const name = `Reconsider${tag()}`;
    const item = await candidate(name);
    await sql`UPDATE rootdata_projects SET review_status = ${state === "rejected" ? "rejected" : "pending"},
      tracking_status = ${state === "paused" ? "paused" : "watching"} WHERE id = ${item.id}`;
    const updateId = await report(`${name} launches a public beta with new product details`);
    await discoverFundingCandidates();
    const links = await sql`SELECT kind FROM rootdata_evidence WHERE project_id = ${item.id} AND article_id = ${updateId}`;
    assert.equal(links.length, state === "paused" ? 0 : 1);
    if (state !== "paused") assert.equal(links[0]!.kind, "update");
    assert.equal(await fundingProject(item.id), null, "a new report does not bypass model review");
  }
});

test("a corrected financing report retains its reviewed canonical project identity", async () => {
  const canonical = `Canonical${tag()}`;
  const extracted = `Investor backed ${canonical}`;
  const item = await candidate(extracted);
  await updateFundingProject(item.id, {version: item.version, name: canonical, reason: "Corrected the financing entity"}, "test-admin");
  await sql`UPDATE publications SET summary='Updated details about the financing and developer product.', revision=revision+1
    WHERE article_id=${item.articleId}`;
  await discoverFundingCandidates();
  const projects = await sql`SELECT id,name FROM rootdata_projects WHERE name IN (${canonical},${extracted})`;
  assert.deepEqual(projects.map(p=>({id:p.id,name:p.name})), [{id:item.id,name:canonical}]);
  const [link] = await sql`SELECT e.kind,e.publication_revision,p.revision FROM rootdata_evidence e
    JOIN publications p ON p.article_id=e.article_id WHERE e.project_id=${item.id} AND e.article_id=${item.articleId}`;
  assert.equal(link!.kind, "funding");
  assert.equal(link!.publication_revision, link!.revision);
});

test("Basic enrichment reuses durable receipts and respects the seven day refresh", async () => {
  await sql`UPDATE rootdata_projects SET next_refresh_at = now() + interval '8 days'`;
  const item = await candidate(`Cache${tag()}`);
  process.env.ROOTDATA_ENABLED = "true";
  process.env.ROOTDATA_API_KEY = "rootdata-test-key";
  process.env.ROOTDATA_DAILY_CREDITS = "24";
  process.env.ROOTDATA_MONTHLY_CREDITS = "800";
  const name = (await sql`SELECT name FROM rootdata_projects WHERE id = ${item.id}`)[0]!.name as string;
  let detailCalls = 0;
  let searchCalls = 0;
  const fake: RootDataProvider = {
    quota: async () => ({ level: "basic", credits: 1000, totalCredits: 1000, periodStart: null, periodEnd: null }),
    search: async () => { searchCalls++; return [{ id: 4321, type: 1, name, logo: null, introduce: null, active: true, rootdataurl: null }]; },
    project: async () => { detailCalls++; return { projectId: 4321, name, logo: null, oneLiner: "A basic profile", description: null, tags: ["Infra"], active: true, rootdataUrl: "https://www.rootdata.com/Projects/detail/example", website: null, twitter: null }; },
  };
  await enrichFundingProjects(fake);
  await enrichFundingProjects(fake);
  assert.equal(detailCalls, 1);
  assert.equal(searchCalls, 1);
  const [stored] = await sql`SELECT profile, next_refresh_at, profile_updated_at FROM rootdata_projects WHERE id = ${item.id}`;
  assert.equal(stored!.profile.oneLiner, "A basic profile");
  assert.ok(stored!.next_refresh_at.getTime() - stored!.profile_updated_at.getTime() > 6 * 86_400_000);
  assert.equal(await fundingProject(item.id), null, "a profile never auto-approves financing evidence");
  const [receipt] = await sql`SELECT response FROM receipts WHERE service = 'rootdata' AND purpose = 'rootdata.quotacredits' ORDER BY id DESC LIMIT 1`;
  assert.equal(JSON.stringify(receipt).includes(process.env.ROOTDATA_API_KEY), false);
});

test("concurrent billed calls cannot overspend daily credits and unknown outcomes remain reserved", async () => {
  process.env.ROOTDATA_DAILY_CREDITS = "4";
  process.env.ROOTDATA_MONTHLY_CREDITS = "800";
  await sql`DELETE FROM rootdata_credit_reservations`;
  const account = sha256("rootdata-test-key").slice(0, 20);
  let calls = 0;
  const jobs = [1, 2, 3].map((n) => paidRequest({ service: "rootdata", purpose: "rootdata.budget_test", identity: { n, tag: tag() } },
    async () => { calls++; return { response: {} }; }, (db) => reserveRootDataCredits(db, 2, account)));
  const results = await Promise.allSettled(jobs);
  assert.equal(calls, 2);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason instanceof BudgetExceededError).length, 1);
  process.env.ROOTDATA_DAILY_CREDITS = "6";
  const request = { service: "rootdata", purpose: "rootdata.unknown_test", identity: { tag: tag() } };
  await assert.rejects(paidRequest(request, async () => { throw new Error("timeout"); }, (db) => reserveRootDataCredits(db, 2, account)), ReceiptUnknownError);
  await assert.rejects(paidRequest(request, async () => { throw new Error("must not resend"); }, (db) => reserveRootDataCredits(db, 2, account)), ReceiptUnknownError);
  const [used] = await sql<{ credits: number }[]>`SELECT sum(credits) AS credits FROM rootdata_credit_reservations`;
  assert.equal(used!.credits, 6);
});

test("admin review is version checked and audited", async () => {
  const item = await candidate(`Review${tag()}`);
  await updateFundingProject(item.id, { version: item.version, reason: "Paused pending investigation", trackingStatus: "paused" }, "test-admin");
  await assert.rejects(updateFundingProject(item.id, { version: item.version, reason: "stale", trackingStatus: "watching" }, "test-admin"), /刷新/);
  const rows = await sql`SELECT actor, reason FROM audit_log WHERE subject = ${`rootdata:${item.id}`}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, "test-admin");
});

test("withdrawn candidates at the head of the refresh queue do not starve valid projects", async () => {
  process.env.ROOTDATA_DAILY_CREDITS = "24";
  await sql`UPDATE rootdata_projects SET next_refresh_at = now() + interval '8 days'`;
  for (let i = 0; i < 12; i++) {
    const name = `Withdrawn${tag()}`;
    await sql`INSERT INTO rootdata_projects (name, name_key, next_refresh_at) VALUES (${name}, ${name.toLowerCase()}, now() - interval '1 day')`;
  }
  const valid = await candidate(`Fair${tag()}`);
  const name = (await sql`SELECT name FROM rootdata_projects WHERE id = ${valid.id}`)[0]!.name as string;
  let calls = 0;
  const fake: RootDataProvider = {
    quota: async () => ({ level: "basic", credits: 1000, totalCredits: 1000, periodStart: null, periodEnd: null }),
    search: async () => [{ id: 7890, type: 1, name, logo: null, introduce: null, active: true, rootdataurl: null }],
    project: async () => { calls++; return { projectId: 7890, name, logo: null, oneLiner: null, description: null, tags: [], active: true, rootdataUrl: null, website: null, twitter: null }; },
  };
  await enrichFundingProjects(fake);
  await enrichFundingProjects(fake);
  assert.equal(calls, 1);
});

test("explicit API rejection is failed, while invalid or unknown responses remain fenced", async () => {
  await sql`UPDATE rootdata_projects SET next_refresh_at = now() + interval '8 days'`;
  await candidate(`Refusal${tag()}`);
  const fail = async (): Promise<never> => { throw new RootDataError("RootData HTTP 403", 403); };
  await assert.rejects(enrichFundingProjects({ quota: fail, search: fail, project: fail }), /403/);
  const [receipt] = await sql`SELECT status FROM receipts WHERE purpose = 'rootdata.ser_inv' ORDER BY id DESC LIMIT 1`;
  assert.equal(receipt!.status, "failed");
});
