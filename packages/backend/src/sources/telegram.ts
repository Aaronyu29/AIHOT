// Telegram's public channel preview is a free, paginated listing. Message dates belong to the
// Telegram permalink; cited announcement links are provenance, not articles dated by this post.
import * as cheerio from "cheerio";
import { languageHeaders, requireOk } from "../lib/http-fetch.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { readPublicationDate } from "./dates.ts";
import { fetchListing } from "./listing-fetch.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

interface TelegramMessage { id: number; candidate: Candidate | null }
interface TelegramPage { messages: TelegramMessage[]; nextBefore: number | null }
interface TelegramCursor {
  channel: string;
  highWaterId: number;
  pendingBefore: number | null;
  pendingHighWaterId: number | null;
}

function positiveId(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (!/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function listingUrl(input: string): { url: URL; channel: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw new FetchError("telegram_public: invalid url"); }
  const channel = /^\/s\/([A-Za-z0-9_]+)\/?$/.exec(url.pathname)?.[1];
  if (!channel || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new FetchError("telegram_public: url must be a public /s/channel listing");
  }
  url.search = "";
  url.hash = "";
  return { url, channel };
}

function externalLink(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

/** Parse the public preview only: no media download, detail reads or paid rendering. */
export function parseTelegramPublic(html: string, input: string): TelegramPage {
  const { url, channel } = listingUrl(input);
  const $ = cheerio.load(html);
  const messages: TelegramMessage[] = [];
  const seen = new Set<number>();
  const elements = $(".tgme_widget_message");
  if (!elements.length) throw new FetchError("telegram_public: no message identities (preview unavailable or changed)");
  for (const node of elements.toArray()) {
    const el = $(node);
    const post = el.attr("data-post") ?? "";
    const parts = /^([A-Za-z0-9_]+)\/(\d+)$/.exec(post);
    const id = positiveId(parts?.[2]);
    if (!id || parts?.[1]?.toLowerCase() !== channel.toLowerCase() || seen.has(id)) {
      throw new FetchError("telegram_public: invalid or duplicate message identity");
    }
    seen.add(id);
    const messageUrl = `https://t.me/${post}`;
    const dateLink = el.find(".tgme_widget_message_date").first();
    if (dateLink.attr("href") !== messageUrl) throw new FetchError("telegram_public: message permalink does not match identity");
    const textEl = el.find(".tgme_widget_message_text").first().clone();
    textEl.find("br").replaceWith("\n");
    textEl.find("p, div").prepend("\n").append("\n");
    const lines = textEl.text().split(/\r?\n/).map(collapseWhitespace)
      .filter(line => line && !/^[\s\p{P}\u2500-\u257f=+~]+$/u.test(line));
    if (!lines.length || el.hasClass("service_message")) {
      messages.push({ id, candidate: null });
      continue;
    }
    const linkedUrls = [...new Set(textEl.find("a[href]").toArray().map(a => externalLink($(a).attr("href"))).filter(u => u !== null))];
    const announcementUrls: string[] = [];
    const announcementLines = new Set<string>();
    for (const line of (textEl.html() ?? "").split(/\r?\n/)) {
      const fragment = cheerio.load(line);
      if (!/^\s*(?:source|来源|原文)\s*[:：]/i.test(fragment.text())) continue;
      for (const a of fragment("a[href]").toArray()) {
        const href = externalLink(fragment(a).attr("href"));
        if (href) {
          if (!announcementUrls.includes(href)) announcementUrls.push(href);
          announcementLines.add(collapseWhitespace(fragment.text()));
        }
      }
    }
    const datetime = dateLink.find("time[datetime]").first().attr("datetime");
    // A preview normally supplies an explicit offset. A missing zone is not a real Telegram timestamp.
    const date = readPublicationDate(datetime && /(?:Z|[+-]\d{2}:\d{2})$/.test(datetime) ? datetime : null);
    const part = /^\[\d+\/\d+\]$/.test(lines[0]!) ? lines[0] : null;
    const partHeadline = part && lines[1] ? lines[1] : null;
    const headline = partHeadline ? `${part} ${partHeadline}` : lines[0]!;
    const title = headline.length > 160 ? `${headline.slice(0, 159)}…` : headline;
    const summaryLines = !part && lines[0]!.length > 160 ? lines : lines.slice(1);
    // Keep citations visible in summary-only exports. Reserve space before truncating prose, and
    // replace the original Source line so a URL used as its own link label is not repeated.
    const citations: string[] = [];
    for (const href of announcementUrls) {
      const citation = `Source: ${href}`;
      if ([...citations, citation].join("\n").length <= 2000) citations.push(citation);
    }
    const footer = citations.join("\n");
    const summary = summaryLines.filter(line => !announcementLines.has(line)).join("\n");
    const excerpt = footer ? `${summary.slice(0, Math.max(0, 1999 - footer.length))}\n${footer}`.trimStart() : summary.slice(0, 2000);
    messages.push({ id, candidate: {
      url: messageUrl, title, excerpt: excerpt || null,
      ...date, bodyStatus: "none",
      raw: { telegramMessageUrl: messageUrl, telegramMessageId: id, telegramChannel: channel,
        publicationTimeSource: "telegram_message", linkedUrls, announcementUrls },
    } });
  }
  messages.sort((a, b) => b.id - a.id);
  const oldest = messages.at(-1)!.id;
  const cursors = new Set<number>();
  // The head's canonical URL also has ?before=; it is NOT the previous page.
  for (const node of $("a[data-before][href], link[rel='prev'][href]").toArray()) {
    const href = $(node).attr("href")!;
    let next: URL;
    try { next = new URL(href, url); } catch { throw new FetchError("telegram_public: invalid previous-page link"); }
    const before = positiveId(next.searchParams.get("before"));
    if (next.origin !== url.origin || next.pathname.replace(/\/$/, "").toLowerCase() !== url.pathname.replace(/\/$/, "").toLowerCase()
      || before !== oldest) throw new FetchError("telegram_public: invalid previous-page boundary");
    cursors.add(before);
  }
  if (cursors.size > 1) throw new FetchError("telegram_public: inconsistent previous-page boundaries");
  return { messages, nextBefore: [...cursors][0] ?? null };
}

function pageLimit(value: unknown, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new FetchError("telegram_public: page limits must be integers from 1 to 20");
  return n;
}

export async function fetchTelegramPublic(source: SourceRow): Promise<{ candidates: Candidate[]; cursor: { telegramPublic: TelegramCursor } }> {
  const { url, channel } = listingUrl(String(source.config.url ?? ""));
  const maxPages = pageLimit(source.config.maxPages, 3);
  const initialPages = Math.min(maxPages, pageLimit(source.config.initialBackfillPages, 2));
  const saved = source.cursor?.telegramPublic;
  const sameChannel = typeof saved?.channel === "string" && saved.channel.toLowerCase() === channel.toLowerCase();
  const highWaterId = sameChannel ? positiveId(saved.highWaterId) ?? 0 : 0;
  const pendingBefore = sameChannel ? positiveId(saved.pendingBefore) : null;
  const pendingHigh = sameChannel ? positiveId(saved.pendingHighWaterId) : null;
  const continuing = !!highWaterId && !!pendingBefore && !!pendingHigh && pendingHigh > highWaterId;
  let before = continuing ? pendingBefore : null;
  let newest = continuing ? pendingHigh! : highWaterId;
  const candidates: Candidate[] = [];
  const collected = new Set<number>();
  let completed = false;
  for (let page = 0; page < (highWaterId ? maxPages : initialPages); page++) {
    const request = new URL(url);
    if (before) request.searchParams.set("before", String(before));
    const response = requireOk(await fetchListing(request.toString(), {
      headers: { accept: "text/html", ...languageHeaders(source.config.acceptLanguage) }, timeoutMs: 25_000,
    }));
    const redirected = new URL(response.url);
    if (redirected.origin !== request.origin || redirected.pathname.toLowerCase().replace(/\/$/, "") !== url.pathname.toLowerCase().replace(/\/$/, "")) {
      throw new FetchError("telegram_public: unexpected listing redirect");
    }
    const parsed = parseTelegramPublic(response.text(), url.toString());
    const oldest = parsed.messages.at(-1)!.id;
    if (before && oldest >= before || parsed.messages.every(message => collected.has(message.id))) {
      throw new FetchError("telegram_public: pagination did not advance; cursor preserved");
    }
    for (const message of parsed.messages) {
      if (before && message.id >= before) continue;
      newest = Math.max(newest, message.id);
      if (!collected.has(message.id) && message.id > highWaterId && message.candidate) candidates.push(message.candidate);
      collected.add(message.id);
    }
    if (oldest <= highWaterId) { completed = true; break; }
    if (parsed.nextBefore === null) {
      if (highWaterId) throw new FetchError("telegram_public: history boundary unavailable; cursor preserved");
      completed = true;
      break;
    }
    before = parsed.nextBefore;
  }
  // Initial import is explicitly bounded. Incremental overflow keeps the old high-water mark and
  // a continuation, so a busy channel cannot silently lose the interval between two polling runs.
  const pending = highWaterId > 0 && !completed;
  return { candidates, cursor: { telegramPublic: {
    channel, highWaterId: pending ? highWaterId : newest,
    pendingBefore: pending ? before : null, pendingHighWaterId: pending ? newest : null,
  } } };
}
