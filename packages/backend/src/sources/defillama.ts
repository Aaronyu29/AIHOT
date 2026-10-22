// DefiLlama publishes a full protocol snapshot, not a feed of project launches.
import { languageHeaders, requireOk } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { fetchListing } from "./listing-fetch.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

interface RecentCursor {
  version: 1;
  lastListedAt: number;
  seenIds: string[];
}

export interface DefiLlamaRecentRead {
  candidates: Candidate[];
  cursor: Record<string, unknown> & { defillamaRecent: RecentCursor };
}

interface Protocol {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  projectUrl: string | null;
  listedAt: number;
}

const API_URL = "https://api.llama.fi/protocols";
const DATE_NOTE = "DefiLlama 新增收录记录；收录时间不等于项目上线时间。";

function plain(value: unknown): string | null {
  return typeof value === "string" ? collapseWhitespace(stripTags(value)).trim() || null : null;
}

function externalId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function projectUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function readCursor(source: SourceRow): RecentCursor | null {
  const previous = source.cursor?.defillamaRecent;
  if (previous === undefined || previous === null) return null;
  if (previous.version !== 1 || !Number.isSafeInteger(previous.lastListedAt) || previous.lastListedAt < 0
    || !Array.isArray(previous.seenIds) || !previous.seenIds.every((id: unknown) => typeof id === "string" && id.length > 0)) {
    throw new FetchError("invalid DefiLlama Recent cursor");
  }
  return previous as RecentCursor;
}

/** Pure snapshot parser. Missing dates stay unknown; no discovery time becomes a publication date. */
export function parseDefiLlamaRecent(data: unknown, source: SourceRow): DefiLlamaRecentRead {
  if (!Array.isArray(data) || data.length === 0) throw new FetchError("DefiLlama protocols response is not a non-empty array");
  const previous = readCursor(source);
  const configuredMax = source.config.maxItems ?? 30;
  if (!Number.isInteger(configuredMax) || configuredMax < 1 || configuredMax > 100) {
    throw new FetchError("DefiLlama Recent maxItems must be an integer from 1 to 100");
  }
  const seen = new Set(previous?.seenIds ?? []);
  const observed = new Set<string>();
  const protocols = new Map<string, Protocol>();
  const latestAllowed = Math.floor(Date.now() / 1000) + 3600;
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = externalId(item.id);
    if (!id) continue;
    observed.add(id);
    const name = plain(item.name);
    const slug = typeof item.slug === "string" ? item.slug.trim() : "";
    const listedAt = item.listedAt;
    // Every event needs its own source page. A shared /recent fallback would make unrelated
    // protocols look like reports of the same URL to the event grouper.
    if (!name || !slug || typeof listedAt !== "number" || !Number.isSafeInteger(listedAt) || listedAt <= 0 || listedAt > latestAllowed) continue;
    const prior = protocols.get(id);
    // Duplicate rows do not create duplicate events or move an identity's listing date forward.
    if (prior && prior.listedAt <= listedAt) continue;
    protocols.set(id, {
      id, name, listedAt, slug,
      description: plain(item.description),
      projectUrl: projectUrl(item.url),
    });
  }
  if (observed.size === 0) throw new FetchError("DefiLlama protocols response contains no protocol ids");
  const rows = [...protocols.values()].sort((a, b) => b.listedAt - a.listedAt || a.id.localeCompare(b.id));
  // Bootstrap establishes the complete baseline but only imports the latest bounded sample.
  // Later reads are not truncated: advancing a watermark past unreturned rows would lose them.
  const selected = previous
    ? rows.filter(row => !seen.has(row.id) && row.listedAt >= previous.lastListedAt)
    : rows.slice(0, configuredMax);
  const candidates: Candidate[] = selected.map(row => {
    const publishedAt = new Date(row.listedAt * 1000);
    return {
      identityKey: `defillama:listing:${row.id}`,
      url: `https://defillama.com/protocol/${encodeURIComponent(row.slug)}`,
      title: `[新增收录] ${row.name}`,
      author: "DefiLlama",
      publishedAt,
      publicationTime: publishedAt.toISOString(),
      excerpt: row.description ? `${row.description.slice(0, 1800)}\n\n${DATE_NOTE}` : DATE_NOTE,
      bodyText: null,
      bodyHtml: null,
      bodyStatus: "none",
      raw: {
        adapter: "defillama_recent", externalId: row.id, eventType: "listing",
        listedAt: row.listedAt, dateSemantics: "defillama_listing_not_project_launch",
        description: row.description, projectUrl: row.projectUrl,
      },
    };
  });
  // Also remember undated, invalid, and newly discovered historical ids. Filling their metadata or
  // temporarily removing/reintroducing them must not announce a new project or replay old listings.
  for (const id of observed) seen.add(id);
  return {
    candidates,
    cursor: {
      ...(source.cursor ?? {}),
      defillamaRecent: {
        version: 1,
        lastListedAt: Math.max(previous?.lastListedAt ?? 0, selected[0]?.listedAt ?? 0),
        seenIds: [...seen].sort(),
      },
    },
  };
}

export async function fetchDefiLlamaRecent(source: SourceRow): Promise<DefiLlamaRecentRead> {
  const response = requireOk(await fetchListing(String(source.config.url ?? API_URL), {
    headers: { accept: "application/json", ...languageHeaders(source.config.acceptLanguage) },
    redirectPolicy: "same-origin",
    timeoutMs: 25_000,
    // The public snapshot was already 9.35 MB in October 2026, above the normal listing limit.
    maxBytes: 16 * 1024 * 1024,
  }));
  let data: unknown;
  try { data = JSON.parse(response.text()); }
  catch { throw new FetchError("DefiLlama protocols response is not JSON"); }
  return parseDefiLlamaRecent(data, source);
}
