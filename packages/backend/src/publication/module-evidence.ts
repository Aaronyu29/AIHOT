// Modules attach their own records to these current public summaries. The public scope stays here;
// callers re-read the IDs for every response so a cached relation never preserves a withdrawn report.
import { sql, type Db } from "../db.ts";
import { listedCondition, compositeCondition } from "./scope.ts";
import { publicSourceName } from "./rules.ts";

export interface PublishedEvidence {
  articleId: string;
  revision: number;
  title: string;
  originalTitle: string;
  summary: string;
  url: string;
  sourceName: string;
  publishedAt: string;
}

export async function readPublishedEvidence(
  options: { ids?: readonly string[]; since?: Date; limit?: number; offset?: number } = {},
  db: Db = sql,
): Promise<PublishedEvidence[]> {
  if (options.ids?.length === 0) return [];
  const rows = await db<{ article_id: string; revision: number; title: string; original_title: string | null; summary: string | null; url: string; source_name: string; published_at: Date }[]>`
    SELECT p.article_id, p.revision, p.title, p.original_title, p.summary, p.url, s.name AS source_name, p.published_at
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE ${listedCondition(new Date())} AND NOT ${compositeCondition()}
      AND p.published_at IS NOT NULL
      ${options.ids ? sql`AND p.article_id = ANY(${[...options.ids]}::text[])` : sql``}
      ${options.since ? sql`AND p.published_at >= ${options.since}` : sql``}
    ORDER BY p.published_at DESC, p.article_id
    LIMIT ${Math.min(5000, Math.max(1, options.limit ?? 1000))} OFFSET ${Math.max(0, options.offset ?? 0)}`;
  return rows.map((r) => ({ articleId: r.article_id, revision: r.revision, title: r.title,
    originalTitle: r.original_title ?? "", summary: r.summary ?? "", url: r.url,
    sourceName: publicSourceName(r.source_name), publishedAt: r.published_at.toISOString() }));
}
