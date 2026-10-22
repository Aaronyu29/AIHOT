import assert from "node:assert/strict";
import { test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { fetchDefiLlamaRecent, parseDefiLlamaRecent } from "@aihot/backend/sources/defillama";
import type { SourceRow } from "@aihot/backend/sources/types";

const epoch = 1_790_000_000;
const source = (cursor: SourceRow["cursor"] = null, overrides: Record<string, unknown> = {}): SourceRow => ({
  id: "defillama-recent", name: "DefiLlama Recent", kind: "json_list", config: { adapter: "defillama_recent", ...overrides }, cursor,
  participation_mode: "editorial", tier: "T1", first_party: false, interval_minutes: 60, enabled: true, fail_count: 0,
});
const protocol = (id: number, listedAt: unknown = epoch + id, extra: Record<string, unknown> = {}) => ({
  id: String(id), name: `Protocol ${id}`, slug: `protocol-${id}`, url: `https://project${id}.example/`,
  description: `Description ${id}`, listedAt, ...extra,
});

test("first snapshot imports only the newest 30 listings and establishes every id as the baseline", () => {
  const input = Array.from({ length: 42 }, (_, i) => protocol(i + 1)).reverse();
  const first = parseDefiLlamaRecent(input, source());
  assert.equal(first.candidates.length, 30);
  assert.equal(first.candidates[0].identityKey, "defillama:listing:42");
  assert.equal(first.candidates.at(-1)?.identityKey, "defillama:listing:13");
  assert.equal(first.cursor.defillamaRecent.seenIds.length, 42);
  assert.equal(first.cursor.defillamaRecent.lastListedAt, epoch + 42);
  assert.deepEqual(parseDefiLlamaRecent(input.reverse(), source(first.cursor)).candidates, []);
});

test("listing event keeps its source timestamp, description and protocol page without claiming a launch", () => {
  const { candidates } = parseDefiLlamaRecent([protocol(1, epoch, { name: "<b>Example</b>", description: "A <b>lending</b> protocol" })], source());
  const item = candidates[0];
  assert.equal(item.title, "[新增收录] Example");
  assert.equal(item.url, "https://defillama.com/protocol/protocol-1");
  assert.equal(item.publicationTime, new Date(epoch * 1000).toISOString());
  assert.equal(item.publishedAt?.getTime(), epoch * 1000);
  assert.match(item.excerpt!, /^A lending protocol/);
  assert.match(item.excerpt!, /收录时间不等于项目上线时间/);
  assert.equal(item.bodyStatus, "none");
  assert.equal(item.bodyText, null);
  assert.deepEqual(item.raw, {
    adapter: "defillama_recent", externalId: "1", eventType: "listing", listedAt: epoch,
    dateSemantics: "defillama_listing_not_project_launch", description: "A lending protocol", projectUrl: "https://project1.example/",
  });
});

test("same-second new ids are collected once; old rows, revisions and reintroduced ids are not new events", () => {
  const baseline = parseDefiLlamaRecent([protocol(1, epoch), protocol(2, epoch - 100)], source());
  const input = [protocol(1, epoch + 100, { name: "Renamed" }), protocol(3, epoch), protocol(4, epoch - 1), protocol(5, epoch + 1)];
  const second = parseDefiLlamaRecent(input, source({ ...baseline.cursor, retained: "existing cursor data" }));
  assert.deepEqual(second.candidates.map(c => c.identityKey), ["defillama:listing:5", "defillama:listing:3"]);
  assert.equal(second.cursor.retained, "existing cursor data");
  // Existing metadata changing its listedAt must not move the new-record watermark past real additions.
  assert.equal(second.cursor.defillamaRecent.lastListedAt, epoch + 1);
  assert.deepEqual(parseDefiLlamaRecent([...input, protocol(2, epoch + 500)], source(second.cursor)).candidates, []);
  assert.equal(parseDefiLlamaRecent([...input, protocol(6, epoch + 2)], source(second.cursor)).candidates.length, 1);
  assert.ok(second.cursor.defillamaRecent.seenIds.includes("4"));
});

test("incremental arrivals are never truncated when more than maxItems share a polling interval", () => {
  const baseline = parseDefiLlamaRecent([protocol(1)], source(null, { maxItems: 2 }));
  const arrivals = Array.from({ length: 35 }, (_, i) => protocol(i + 2));
  const next = parseDefiLlamaRecent([protocol(1), ...arrivals], source(baseline.cursor, { maxItems: 2 }));
  assert.equal(next.candidates.length, 35);
  assert.deepEqual(parseDefiLlamaRecent(arrivals, source(next.cursor)).candidates, []);
});

test("unknown dates are not invented and later metadata completion cannot turn known ids into new listings", () => {
  const input = [protocol(1), protocol(2, null), protocol(3, "not a date"), protocol(4, epoch + 4, { name: null }), protocol(5, 9e15)];
  const first = parseDefiLlamaRecent(input, source());
  assert.equal(first.candidates.length, 1);
  assert.equal(first.cursor.defillamaRecent.seenIds.length, 5);
  assert.deepEqual(parseDefiLlamaRecent(input.map((_, i) => protocol(i + 1)), source(first.cursor)).candidates, []);
  const noDescription = parseDefiLlamaRecent([protocol(7, epoch, { description: null, url: "javascript:alert(1)" })], source()).candidates[0];
  assert.equal((noDescription.raw as any).description, null);
  assert.equal((noDescription.raw as any).projectUrl, null);
  assert.equal(noDescription.url, "https://defillama.com/protocol/protocol-7");
  assert.equal(noDescription.excerpt, "DefiLlama 新增收录记录；收录时间不等于项目上线时间。");
});

test("records without a protocol slug cannot share a listing URL and collapse unrelated events", () => {
  const result = parseDefiLlamaRecent([protocol(1), protocol(2, epoch, { slug: null }), protocol(3, epoch, { slug: "" })], source());
  assert.deepEqual(result.candidates.map(c => c.identityKey), ["defillama:listing:1"]);
  assert.equal(result.cursor.defillamaRecent.seenIds.length, 3);
});

test("duplicate ids have one stable identity, and malformed snapshots or cursors fail without mutation", () => {
  const cursor = { defillamaRecent: { version: 1, lastListedAt: epoch, seenIds: ["1"] } };
  const saved = structuredClone(cursor);
  assert.throws(() => parseDefiLlamaRecent({ protocols: [] }, source(cursor)), /non-empty array/);
  assert.throws(() => parseDefiLlamaRecent([], source(cursor)), /non-empty array/);
  assert.throws(() => parseDefiLlamaRecent([{}], source(cursor)), /no protocol ids/);
  assert.deepEqual(cursor, saved);
  assert.throws(() => parseDefiLlamaRecent([protocol(1)], source({ defillamaRecent: { version: 2 } })), /invalid.*cursor/);
  assert.throws(() => parseDefiLlamaRecent([protocol(1)], source(null, { maxItems: 1000 })), /maxItems/);
  const duplicate = parseDefiLlamaRecent([protocol(2, epoch + 2), protocol(2, epoch + 1)], source());
  assert.equal(duplicate.candidates.length, 1);
  assert.equal(duplicate.candidates[0].publicationTime, new Date((epoch + 1) * 1000).toISOString());
});

test("guarded public fetch accepts the real snapshot size and rejects malformed JSON", async () => {
  const previousDispatcher = getGlobalDispatcher();
  const previousPrivate = config.allowPrivateNetworkFetch;
  const previousProxy = config.egressProxyUrl;
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  config.allowPrivateNetworkFetch = true;
  config.egressProxyUrl = null;
  try {
    const origin = "https://api.llama.fi";
    // The live protocol snapshot exceeds the ordinary listing fetcher's 8 MiB limit.
    const input = [protocol(1, epoch, { unused: "x".repeat(9 * 1024 * 1024) })];
    agent.get(origin).intercept({ path: "/protocols" }).reply(200, JSON.stringify(input));
    assert.equal((await fetchDefiLlamaRecent(source())).candidates.length, 1);
    agent.get(origin).intercept({ path: "/protocols" }).reply(200, "not json");
    await assert.rejects(fetchDefiLlamaRecent(source()), /not JSON/);
    agent.assertNoPendingInterceptors();
  } finally {
    config.allowPrivateNetworkFetch = previousPrivate;
    config.egressProxyUrl = previousProxy;
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
  }
});
