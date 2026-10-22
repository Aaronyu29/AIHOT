// Public project directories have no announcement date. Keep that absence explicit; event dates,
// application deadlines and the collection clock cannot stand in for publication time.
import * as cheerio from "cheerio";
import { collapseWhitespace } from "../lib/text.ts";
import { identityKeyForUrl, normalizeUrl } from "../lib/url.ts";
import { languageHeaders, requireOk } from "../lib/http-fetch.ts";
import { fetchListing } from "./listing-fetch.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export type ProjectPageAdapter = "ethglobal_showcase" | "csx_accelerator" | "easy_residency";

function publicLink(value: string | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

const undated = { publishedAt: null, publicationTime: null, bodyStatus: "none" as const };

function showcase($: cheerio.CheerioAPI, base: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_i, node) => {
    const card = $(node);
    const url = publicLink(card.attr("href"), base);
    if (!url || new URL(url).origin !== new URL(base).origin || !/^\/showcase\/[^/]+\/?$/.test(new URL(url).pathname)) return;
    const title = collapseWhitespace(card.find("h2").first().text());
    const identityKey = identityKeyForUrl(url)!;
    if (!title || seen.has(identityKey)) return;
    seen.add(identityKey);
    const excerpt = collapseWhitespace(card.find("p").first().text()) || null;
    const event = card.find("div").toArray().map(el => collapseWhitespace($(el).text())).find(text => /^ETHGlobal\s/.test(text)) ?? null;
    out.push({ url, title, identityKey, excerpt, ...undated,
      raw: { externalId: new URL(url).pathname.split("/").filter(Boolean).at(-1), listingUrl: base, eventType: "prototype", eventLabel: event, listingPublicationDateUnknown: true },
    });
  });
  return out;
}

// Read only literal name/url fields from the page's modal attributes. Never evaluate page scripts.
function literalField(text: string, name: "name" | "url"): string | null {
  const match = new RegExp(String.raw`\b${name}\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")`).exec(text);
  if (!match) return null;
  return (match[1] ?? match[2]!).replace(/\\([\\'"])/g, "$1");
}

function accelerator($: cheerio.CheerioAPI, base: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  $("button").each((_i, node) => {
    const action = $(node).attr("@click") ?? "";
    if (!/^\s*openModal\(\s*\{/.test(action)) return;
    const name = collapseWhitespace(literalField(action, "name") ?? "");
    const website = publicLink(literalField(action, "url") ?? undefined, base);
    if (!name || !website) return;
    const identityKey = `csx:portfolio:${normalizeUrl(website)}`;
    if (seen.has(identityKey)) return;
    seen.add(identityKey);
    out.push({ url: new URL("#companies", base).toString(), title: `a16z CSX: ${name}`, identityKey,
      excerpt: `${name} is listed in the a16z CSX company directory. Project website: ${website}`, ...undated,
      raw: { externalId: identityKey, listingUrl: base, companyWebsite: website, eventType: "accelerator_directory", listingPublicationDateUnknown: true },
    });
  });
  return out;
}

function residency($: cheerio.CheerioAPI, base: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_i, node) => {
    const link = $(node);
    const url = publicLink(link.attr("href"), base);
    if (!url || !["www.yzilabs.com", "yzilabs.com"].includes(new URL(url).hostname) || !/^\/blog\/[^/]+\/?$/.test(new URL(url).pathname)) return;
    const identityKey = identityKeyForUrl(url)!;
    if (seen.has(identityKey)) return;
    seen.add(identityKey);
    const title = collapseWhitespace(link.text().replace(/[↗→]/g, ""));
    if (!title) return;
    out.push({ url, title, identityKey, excerpt: null, ...undated,
      raw: { listingUrl: base, eventType: "accelerator_announcement", listingPublicationDateUnknown: true },
    });
  });
  const season = /\bSeason\s+(\d+)\b/i.exec($(".hero-eyebrow").first().text())?.[1];
  const headline = collapseWhitespace($("h1").first().text());
  if (season && headline) {
    // One stable identity per season, including when the site reuses the same landing-page URL.
    const externalId = `easy:season:${season}`;
    out.push({ url: base, title: `EASY Residency Season ${season}: ${headline}`, identityKey: externalId,
      excerpt: collapseWhitespace($("#program p").first().text() || $(".hero-sub").first().text()) || null,
      ...undated, raw: { externalId, listingUrl: base, eventType: "accelerator_program", listingPublicationDateUnknown: true },
    });
  }
  return out;
}

export function fromProjectPage(html: string, base: string, adapter: ProjectPageAdapter): Candidate[] {
  const $ = cheerio.load(html);
  if (adapter === "ethglobal_showcase") return showcase($, base);
  if (adapter === "csx_accelerator") return accelerator($, base);
  if (adapter === "easy_residency") return residency($, base);
  throw new FetchError(`unsupported project page adapter: ${String(adapter)}`);
}

export async function fetchProjectPage(source: SourceRow): Promise<Candidate[]> {
  const url = String(source.config.url ?? "");
  if (!url) throw new FetchError("url missing");
  const res = requireOk(await fetchListing(url, { headers: { accept: "text/html", ...languageHeaders(source.config.acceptLanguage) }, timeoutMs: 25_000 }));
  const out = fromProjectPage(res.text(), res.url, source.config.adapter);
  if (!out.length) throw new FetchError(`no items matched (${String(source.config.adapter)})`);
  return out;
}
