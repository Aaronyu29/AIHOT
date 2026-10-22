// The source list shows each source's health and why it fails, failing sources first.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { listSources } from "@aihot/backend/admin/sources";
import { sourceQuality } from "../packages/backend/src/admin/source-quality.ts";

after(closeDb);

test("the source list shows health and the failure reason, failing sources first", async () => {
  await sql`INSERT INTO sources (id, name, kind, health, fail_count, last_error) VALUES
    ('list-ok', 'List A', 'rss', 'ok', 0, NULL), ('list-failing', 'List B', 'rss', 'failing', 6, 'HTTP 503')`;
  const { rows, totals } = await listSources({ q: "List" });
  assert.deepEqual(rows.map(({ id, health, fail_count, last_error }) => ({ id, health, fail_count, last_error })), [
    { id: "list-failing", health: "failing", fail_count: 6, last_error: "HTTP 503" },
    { id: "list-ok", health: "ok", fail_count: 0, last_error: null },
  ]);
  assert.equal(totals.failing, 1);
});

const observedAt = new Date("2026-10-22T12:00:00Z");
const daysAgo = (days: number) => new Date(observedAt.getTime() - days * 86400_000);

async function qualityArticle(id: string, source: string, options: {
  at?: Date; state?: string; grouping?: string; relevance?: "pass" | "block" | "unknown" | null;
  revision?: number; inputRevision?: number; backfill?: boolean; scope?: string;
} = {}) {
  const at = options.at ?? daysAgo(1), revision = options.revision ?? 1;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at,revision,backfill,processing_state,grouping_status)
    VALUES (${id},${source},${id},${`https://example.test/${id}`},${id},${at},${at},${revision},${options.backfill ?? false},${options.state ?? "analyzed"},${options.grouping ?? "complete"})`;
  if (options.relevance === null) return null;
  const [analysis] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id,input_revision,origin,relevance,output)
    VALUES (${id},${options.inputRevision ?? revision},'rule',${options.relevance ?? "pass"},${sql.json({ scope: options.scope ?? "single" })}) RETURNING id`;
  return analysis!.id;
}

async function qualityPublication(id: string, analysis: number, options: {
  visibility?: string; revision?: number; seat?: boolean; visibleAfter?: Date;
} = {}) {
  await sql`INSERT INTO publications (article_id,analysis_id,revision,visibility,eligible,selected,seat,title,source_id,channel,url,discovered_at,timeline_at,sort_at,visible_after)
    SELECT id,${analysis},${options.revision ?? 1},${options.visibility ?? "public"},true,true,${options.seat ?? true},title,source_id,'news',url,discovered_at,timeline_at,timeline_at,${options.visibleAfter ?? daysAgo(1)}
    FROM articles WHERE id=${id}`;
}

test("source quality uses settled current analysis and distinguishes selection still awaiting grouping or publication", async () => {
  await sql`INSERT INTO sources (id,name,kind) VALUES ('quality-outcomes','Quality outcomes','rss'),('quality-empty','Quality empty','rss')`;
  const fixtures = [
    ["selected", {}], ["blocked", { state: "blocked", relevance: "block" }],
    ["group-pending", { grouping: "pending" }], ["group-failed", { grouping: "failed" }],
    ["failed", { state: "failed" }], ["new", { state: "new" }], ["unknown", { relevance: "unknown" }],
    ["old-analysis", { revision: 2, inputRevision: 1 }], ["latest-block", {}], ["summary", {}], ["no-seat", {}],
    ["future-release", {}], ["old-publication", { revision: 2 }], ["old-published-analysis", {}],
    ["backfill", { backfill: true }], ["skipped", { state: "skipped", relevance: "block" }],
    ["no-analysis", { state: "new", relevance: null }], ["new-revision", { state: "new", revision: 2, inputRevision: 1, relevance: "block" }],
    ["non-editorial", { state: "skipped", relevance: null }],
  ] satisfies Array<[string, Parameters<typeof qualityArticle>[2]]>;
  const analyses = new Map<string, number>();
  for (const [suffix, options] of fixtures) {
    const analysis = await qualityArticle(`quality-${suffix}`, "quality-outcomes", options);
    if (analysis !== null) analyses.set(suffix, analysis);
  }
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance) VALUES ('quality-latest-block',1,'rule','block'),('quality-old-published-analysis',1,'rule','pass')`;
  await qualityPublication("quality-selected", analyses.get("selected")!);
  await qualityPublication("quality-summary", analyses.get("summary")!, { visibility: "summary-only" });
  await qualityPublication("quality-no-seat", analyses.get("no-seat")!, { seat: false });
  await qualityPublication("quality-future-release", analyses.get("future-release")!, { visibleAfter: daysAgo(-1) });
  await qualityPublication("quality-old-publication", analyses.get("old-publication")!, { revision: 1 });
  await qualityPublication("quality-old-published-analysis", analyses.get("old-published-analysis")!);
  const quality = await sourceQuality(["quality-outcomes", "quality-empty"], 30, observedAt);
  assert.deepEqual(quality.get("quality-outcomes"), {
    received: 19, processed: 12, effective: 9, blocked: 3, pending: 6, failed: 1, backfill: 1,
    pendingGrouping: 2, selectionEvaluated: 10, selected: 1, duplicateEvaluated: 0, duplicates: 0,
    fetchOk: 0, fetchFailed: 0, fetchRunning: 0, budgetSkipped: 0, fetchP95Ms: null,
    effectiveRate: 9 / 12, selectedRate: 1 / 10, duplicateRate: null, fetchSuccessRate: null,
  });
  const empty = quality.get("quality-empty")!;
  assert.equal(empty.received, 0);
  assert.equal(empty.effectiveRate, null);
  assert.equal(empty.selectedRate, null);
  assert.equal(empty.duplicateRate, null);
  assert.equal(empty.fetchSuccessRate, null);
});

test("repeated reporting follows the global first report of a fact, not the story, selection or fetch counts", async () => {
  await sql`INSERT INTO sources (id,name,kind) VALUES ('quality-repeat','Quality repeated','rss'),('quality-other','Quality other','rss')`;
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id,title) VALUES (${randomUUID()},'Quality same story') RETURNING id`;
  const facts = await sql<{ id: number; public_id: string }[]>`INSERT INTO facts (public_id,title,story_id) VALUES
    ('quality-shared','Old fact',${story!.id}),('quality-new-fact','New fact in same story',${story!.id}),
    ('quality-tie','Same instant',NULL),('quality-ambiguous','Another fact',NULL) RETURNING id,public_id`;
  const fact = (name: string) => facts.find(row => row.public_id === `quality-${name}`)!.id;
  async function report(suffix: string, factName: string, options: Parameters<typeof qualityArticle>[2] = {}, role = "report", source = "quality-repeat") {
    const id = `quality-repeat-${suffix}`;
    await qualityArticle(id, source, options);
    await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact(factName)},${id},${role})`;
    return id;
  }
  await report("historical-first", "shared", { at: daysAgo(40) }, "primary", "quality-other");
  await report("later", "shared");
  await report("different-fact", "new-fact");
  const [mergedStory] = await sql<{ id: number }[]>`INSERT INTO stories (public_id,title,merged_into) VALUES (${randomUUID()},'Merged history',${story!.id}) RETURNING id`;
  const [obsoleteFact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,title,story_id) VALUES ('quality-obsolete-fact','Obsolete membership',${mergedStory!.id}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id,article_id) VALUES (${obsoleteFact!.id},'quality-repeat-different-fact')`;
  // Reverse insertion order proves the tie breaker is the article id, not analysis/insertion order.
  await report("tie-z", "tie");
  await report("tie-a", "tie", {}, "primary", "quality-other");
  await report("backfill", "shared", { backfill: true });
  await report("mention", "shared", {}, "mention");
  await report("composite", "shared", { scope: "composite" });
  // Scope follows the current revision's newest analysis, even when other revisions have later ids.
  await sql`UPDATE articles SET revision=2 WHERE id='quality-repeat-different-fact'`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,output) VALUES
    ('quality-repeat-different-fact',1,'rule','pass','{"scope":"composite"}'),
    ('quality-repeat-different-fact',2,'rule','pass','{"scope":"single"}'),
    ('quality-repeat-different-fact',3,'rule','pass','{"scope":"composite"}'),
    ('quality-repeat-historical-first',2,'rule','pass','{"scope":"composite"}'),
    ('quality-repeat-composite',2,'rule','pass','{"scope":"single"}')`;
  await report("group-pending", "shared", { grouping: "pending" });
  await report("blocked", "shared", { state: "blocked", relevance: "block" });
  await report("stale", "shared", { revision: 2, inputRevision: 1 });
  const ambiguous = await report("ambiguous", "shared");
  await sql`INSERT INTO fact_articles (fact_id,article_id) VALUES (${fact("ambiguous")},${ambiguous})`;
  await sql`UPDATE articles SET selection_adds_value=false WHERE source_id='quality-repeat'`;
  await sql`INSERT INTO fetch_runs (source_id,status,found_count,new_count) VALUES ('quality-repeat','ok',100,0)`;
  const quality = (await sourceQuality(["quality-repeat"], 30, observedAt)).get("quality-repeat")!;
  assert.equal(quality.duplicateEvaluated, 3);
  assert.equal(quality.duplicates, 2);
  assert.equal(quality.duplicateRate, 2 / 3);
  // Removing the current membership removes the sample instead of recording a non-duplicate.
  await sql`DELETE FROM fact_articles WHERE article_id='quality-repeat-later'`;
  const after = (await sourceQuality(["quality-repeat"], 30, observedAt)).get("quality-repeat")!;
  assert.equal(after.duplicateEvaluated, 2);
  assert.equal(after.duplicates, 1);
});

test("fetch quality excludes budget skips and running attempts from failure rate and duration", async () => {
  await sql`INSERT INTO sources (id,name,kind) VALUES ('quality-fetch','Quality fetch','rss')`;
  const start = daysAgo(1);
  await sql`INSERT INTO fetch_runs (source_id,started_at,finished_at,status,error) VALUES
    ('quality-fetch',${start},${new Date(start.getTime() + 100)},'ok',NULL),
    ('quality-fetch',${start},${new Date(start.getTime() + 300)},'failed','HTTP 503'),
    ('quality-fetch',${start},${new Date(start.getTime() + 100_000)},'failed','Budget for fetch exhausted (day)'),
    ('quality-fetch',${start},NULL,'running',NULL),
    ('quality-fetch',${daysAgo(31)},${daysAgo(30)},'failed','too old'),
    ('quality-fetch',${daysAgo(-1)},NULL,'running',NULL),
    ('quality-fetch',${start},${start},'skipped','not due')`;
  const quality = (await sourceQuality(["quality-fetch"], 30, observedAt)).get("quality-fetch")!;
  assert.equal(quality.fetchOk, 1);
  assert.equal(quality.fetchFailed, 1);
  assert.equal(quality.fetchRunning, 1);
  assert.equal(quality.budgetSkipped, 1);
  assert.equal(quality.fetchSuccessRate, 0.5);
  assert.equal(quality.fetchP95Ms, 290);
});

test("quality windows use discovery time and include paused sources; invalid windows and sorts are rejected", async () => {
  await sql`INSERT INTO sources (id,name,kind,enabled) VALUES ('quality-windows','Quality windows','rss',false)`;
  for (const day of [3, 15, 60, 100, -1]) await qualityArticle(`quality-day-${day < 0 ? "future" : day}`, "quality-windows", { at: daysAgo(day) });
  for (const [window, expected] of [[7, 1], [30, 2], [90, 3]] as const) {
    const quality = (await sourceQuality(["quality-windows"], window, observedAt)).get("quality-windows")!;
    assert.equal(quality.received, expected);
    assert.equal(quality.effective, expected);
  }
  const paused = await listSources({ q: "quality-windows", enabled: "false", window: 90 });
  assert.equal(paused.windowDays, 90);
  assert.equal(paused.rows[0]?.enabled, false);
  assert.equal(paused.matchedTotal, 1);
  assert.equal((await listSources({ q: "quality-windows", enabled: "true" })).matchedTotal, 0);
  assert.equal((await listSources({ q: "quality-windows" })).windowDays, 30);
  assert.ok(new Date(paused.observedAt).getTime() > 0);
  await assert.rejects(listSources({ window: 14 }), /Invalid/);
  await assert.rejects(listSources({ window: Number.NaN }), /Invalid/);
  await assert.rejects(listSources({ sort: "invalid" as never }), /Invalid/);
});

test("quality sorting measures all filtered sources before pagination and leaves unsampled sources last", async () => {
  await sql`INSERT INTO sources (id,name,kind)
    SELECT 'quality-page-' || n,'Quality page ' || lpad(n::text,3,'0'),'rss' FROM generate_series(1,102) n`;
  const recent = new Date(Date.now() - 60_000);
  await qualityArticle("quality-page-worst", "quality-page-102", { at: recent, state: "blocked", relevance: "block" });
  const bestAnalysis = await qualityArticle("quality-page-best", "quality-page-101", { at: recent });
  const first = await listSources({ q: "Quality page", kind: "rss", sort: "low-effective" });
  assert.equal(first.matchedTotal, 102);
  assert.equal(first.rows.length, 100);
  assert.equal(first.rows[0]?.id, "quality-page-102");
  assert.equal(first.rows[0]?.quality.effectiveRate, 0);
  assert.equal(first.rows[1]?.id, "quality-page-101");
  assert.equal(first.rows[2]?.quality.effectiveRate, null);
  const second = await listSources({ q: "Quality page", sort: "low-effective", page: 2 });
  assert.equal(second.rows.length, 2);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 102);
  assert.equal((await listSources({ q: "Quality page", kind: "web_list", sort: "unstable" })).matchedTotal, 0);
  await qualityPublication("quality-page-best", bestAnalysis!, { visibleAfter: recent });
  const selected = await listSources({ q: "Quality page", sort: "low-selected" });
  assert.deepEqual(selected.rows.slice(0, 2).map(row => [row.id, row.quality.selectedRate]), [["quality-page-102", 0], ["quality-page-101", 1]]);
  await sql`INSERT INTO fetch_runs (source_id,started_at,status,error) VALUES
    ('quality-page-102',${recent},'failed','HTTP 503'),('quality-page-101',${recent},'ok',NULL)`;
  const unstable = await listSources({ q: "Quality page", sort: "unstable" });
  assert.deepEqual(unstable.rows.slice(0, 2).map(row => [row.id, row.quality.fetchSuccessRate]), [["quality-page-102", 0], ["quality-page-101", 1]]);
  await qualityArticle("quality-page-repeat", "quality-page-102", { at: new Date(recent.getTime() + 1000) });
  const [sharedFact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,title) VALUES ('quality-page-fact','Page fact') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id,article_id) VALUES (${sharedFact!.id},'quality-page-best'),(${sharedFact!.id},'quality-page-repeat')`;
  const repeated = await listSources({ q: "Quality page", sort: "high-duplicate" });
  assert.deepEqual(repeated.rows.slice(0, 2).map(row => [row.id, row.quality.duplicateRate]), [["quality-page-102", 1], ["quality-page-101", 0]]);
});
