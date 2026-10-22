// Exercise the collector boundary: page cursors commit only after all pages succeed, and
// summary-only project sources must never schedule article-body extraction.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { adaptIntervals, collectSource } from "@aihot/backend/sources/collect";

const T = tag();
const channel = `ProjectNews${T}`;
const publishedAt = new Date(Date.now() - 60_000).toISOString();
let newerMessages = false;
let failSecondPage = false;
const requested: string[] = [];

function telegramPage(ids: number[], before?: number): string {
  return ids.map(id => `<div class="tgme_widget_message" data-post="${channel}/${id}">
    <div class="tgme_widget_message_text">Project ${id} launches a testnet<br>Official announcement summary ${id}.</div>
    <a class="tgme_widget_message_date" href="https://t.me/${channel}/${id}">${id === 1 ? "<time></time>" : `<time datetime="${publishedAt}"></time>`}</a>
    </div>`).join("") + (before ? `<a data-before="${before}" href="/s/${channel}?before=${before}">Previous messages</a>` : "");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture");
  requested.push(url.pathname + url.search);
  if (url.pathname === `/s/${channel}`) {
    if (failSecondPage && url.searchParams.get("before") === "5") {
      res.writeHead(403); res.end("Preview unavailable"); return;
    }
    res.setHeader("content-type", "text/html");
    if (url.searchParams.get("before") === "3") res.end(telegramPage([2, 1]));
    else if (url.searchParams.get("before") === "5") res.end(telegramPage([4, 3], 3));
    else res.end(newerMessages ? telegramPage([6, 5], 5) : telegramPage([4, 3], 3));
    return;
  }
  if (url.pathname === "/web-list") {
    res.setHeader("content-type", "text/html");
    res.end(`<article><h2><a href="/must-not-fetch/web-${T}">Undated project prototype</a></h2></article>`);
    return;
  }
  if (url.pathname === "/json-list") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ id: `json-${T}`, title: "Undated protocol introduction", url: `${base}/must-not-fetch/json-${T}`, summary: "The official directory describes this protocol." }]));
    return;
  }
  res.writeHead(500); res.end("Article bodies must not be requested");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;

after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

async function createSource(name: string, kind: string, settings: Record<string, unknown>): Promise<string> {
  const id = `project-source-${T}-${name}`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at)
    VALUES (${id},${name},${kind},${sql.json(settings as never)},'T1','editorial','2100-01-01')`;
  return id;
}

const stored = (id: string) => sql`SELECT id,url,published_at,publication_time,body_status,body_text,body_html FROM articles WHERE source_id=${id} ORDER BY url`;
const cursor = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;

test("Telegram collection commits all bounded first-import pages, preserves its cursor on failure, and replays without duplicates", async () => {
  const id = await createSource("telegram", "web_list", { url: `${base}/s/${channel}`, adapter: "telegram_public",
    maxPages: 2, initialBackfillPages: 2, fetchPublicContent: false, _aihot: { initialBackfillLimit: 1 } });
  const first = await collectSource(id, { force: true });
  assert.equal(first.status, "ok");
  assert.equal(first.found, 4);
  assert.equal(first.created, 4, "the adapter's two-page bound must not lose three messages to the generic item cap");
  assert.equal((await stored(id)).length, 4);
  assert.equal((await cursor(id)).telegramPublic.highWaterId, 4);
  const unknown = (await stored(id)).find(row => row.url.endsWith("/1"))!;
  assert.equal(unknown.published_at, null);
  assert.equal(unknown.publication_time, null, "missing Telegram time stays unknown after storage");

  const repeated = await collectSource(id, { force: true });
  assert.equal(repeated.status, "ok");
  assert.equal(repeated.created, 0);
  assert.equal((await stored(id)).length, 4);

  const checkpoint = await cursor(id);
  newerMessages = true;
  failSecondPage = true;
  const failed = await collectSource(id, { force: true });
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /403/);
  assert.deepEqual(await cursor(id), checkpoint, "no successful-page watermark may escape a later page failure");
  assert.equal((await stored(id)).length, 4);
  failSecondPage = false;

  const recovered = await collectSource(id, { force: true });
  assert.equal(recovered.status, "ok");
  assert.equal(recovered.created, 2);
  assert.equal((await stored(id)).length, 6);
  assert.equal((await cursor(id)).telegramPublic.highWaterId, 6);
  assert.equal((await collectSource(id, { force: true })).created, 0);
  assert.ok(requested.includes(`/s/${channel}?before=3`));
  assert.ok(requested.includes(`/s/${channel}?before=5`));
});

for (const kind of ["web_list", "json_list"] as const) test(`${kind} summary-only collection stores no body and queues analysis with unknown dates intact`, async () => {
  const settings = kind === "web_list"
    ? { url: `${base}/web-list`, itemSelector: "article", titleSelector: "h2", linkSelector: "a", fetchPublicContent: false }
    : { url: `${base}/json-list`, mode: "json_api", titlePaths: ["title"], summaryPaths: ["summary"], urlTemplate: "{raw:url}", externalIdPath: "id", fetchPublicContent: false };
  const id = await createSource(kind, kind, settings);
  const result = await collectSource(id, { force: true });
  assert.equal(result.status, "ok");
  assert.equal(result.created, 1);
  const [article] = await stored(id);
  assert.equal(article!.body_status, "none");
  assert.equal(article!.body_text, null);
  assert.equal(article!.body_html, null);
  assert.equal(article!.published_at, null);
  assert.equal(article!.publication_time, null);
  const jobs = await sql`SELECT name FROM pgboss.job WHERE data->>'articleId'=${article!.id}`;
  assert.ok(jobs.some(job => job.name === QUEUES.analyze), "a real processing job is created from the retained listing");
  assert.ok(jobs.every(job => job.name !== QUEUES.extractBody), "the collector must not schedule full-text extraction");
  assert.ok(!requested.some(path => path.startsWith("/must-not-fetch/")));
  assert.equal((await collectSource(id, { force: true })).created, 0);
});

test("daily adaptation preserves configured Telegram polling while ordinary RSS still adapts", async () => {
  const fiveMinutes = await createSource("telegram-five-minutes", "web_list", { url: `${base}/s/FastProjectNews`, adapter: "telegram_public" });
  const fifteenMinutes = await createSource("telegram-fifteen-minutes", "web_list", { url: `${base}/s/RootDataNews`, adapter: "telegram_public" });
  const ordinaryFeed = await createSource("adaptive-rss", "rss", { feedUrl: `${base}/ordinary-feed.xml` });
  await sql`UPDATE sources SET interval_minutes=5 WHERE id IN (${fiveMinutes},${ordinaryFeed})`;
  await sql`UPDATE sources SET interval_minutes=15 WHERE id=${fifteenMinutes}`;

  await adaptIntervals();

  const rows = await sql`SELECT id,interval_minutes FROM sources WHERE id IN (${fiveMinutes},${fifteenMinutes},${ordinaryFeed})`;
  const intervals = new Map(rows.map(row => [row.id, row.interval_minutes]));
  assert.equal(intervals.get(fiveMinutes), 5, "a quiet Telegram channel retains the administrator's five-minute scan");
  assert.equal(intervals.get(fifteenMinutes), 15, "a separately configured fifteen-minute channel also keeps its interval");
  assert.equal(intervals.get(ordinaryFeed), 60, "ordinary low-volume RSS still receives the existing hourly target");
});
