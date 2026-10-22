import { sql, type Db } from "@aihot/backend/db";
import { readPublishedEvidence } from "@aihot/backend/publication/module-evidence";
import type { FundingAdminProject, FundingEvidence, FundingProject, FundingProjectList } from "./contracts.ts";
import type { RootDataProject } from "./client.ts";
import { currentAnalysis, type SavedAnalysis } from './analysis-content.ts';
import { reviewHash } from './review-content.ts';
import type { SavedReview } from './review.ts';

export interface ProjectRow {
  id: number; name: string; name_key: string; rootdata_id: number | null; profile: RootDataProject | null;
  profile_updated_at: Date | null; next_refresh_at: Date; review_status: FundingAdminProject["reviewStatus"];
  tracking_status: FundingProject["trackingStatus"]; public_reason: string; last_error: string | null;
  version: number; created_at: Date; updated_at: Date;
}

export const FUNDING_NOTICE = "融资线索来自站内已公开报道，由模型依据新闻证据自动筛选并持续重评；RootData Basic 仅补充项目基础资料，不提供融资轮次或投资方数据。跟踪依据不构成投资建议。";

export async function projectViews(rows: ProjectRow[], db: Db = sql): Promise<FundingAdminProject[]> {
  if (!rows.length) return [];
  const saved = new Map((await db<(SavedAnalysis & {project_id: number})[]>`SELECT project_id, inputs_hash, output, generated_at, model
    FROM rootdata_analyses WHERE project_id = ANY(${rows.map(r => r.id)}::bigint[])`).map(row => [row.project_id, row]));
  const reviews = new Map((await db<(SavedReview & {project_id: number})[]>`SELECT * FROM rootdata_reviews
    WHERE project_id = ANY(${rows.map(r => r.id)}::bigint[])`).map(row => [row.project_id, row]));
  const relations = await db<{ project_id: number; article_id: string; kind: FundingEvidence["kind"]; publication_revision: number }[]>`
    SELECT project_id, article_id, kind, publication_revision FROM rootdata_evidence WHERE project_id = ANY(${rows.map((r) => r.id)}::bigint[])`;
  const ids = [...new Set(relations.map((r) => r.article_id))];
  const current = new Map<string, Awaited<ReturnType<typeof readPublishedEvidence>>[number]>();
  for (let i = 0; i < ids.length; i += 5000) {
    for (const report of await readPublishedEvidence({ ids: ids.slice(i, i + 5000), limit: 5000 }, db)) current.set(report.articleId, report);
  }
  return rows.map((row) => {
    const evidence: FundingEvidence[] = relations.filter((r) => r.project_id === row.id).flatMap((r) => {
      const report = current.get(r.article_id);
      // A correction must be evaluated again before its old funding relation is shown.
      if (!report || report.revision !== r.publication_revision) return [];
      const { originalTitle: _originalTitle, revision: _revision, ...publicReport } = report;
      return [{ ...publicReport, kind: r.kind }];
    }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const profile = row.profile;
    const view: FundingAdminProject = { id: row.id, name: row.name, description: profile?.description ?? profile?.oneLiner ?? "",
      logo: profile?.logo ?? null, tags: profile?.tags ?? [], rootdataUrl: profile?.rootdataUrl ?? null,
      website: profile?.website ?? null, profileStatus: profile ? "linked" : "pending",
      trackingStatus: row.tracking_status, profileUpdatedAt: row.profile_updated_at?.toISOString() ?? null,
      lastNewsAt: evidence[0]?.publishedAt ?? row.created_at.toISOString(), reasons: row.public_reason ? [row.public_reason] : [], evidence,
      reviewStatus: row.review_status, version: row.version, rootdataId: row.rootdata_id,
      publicReason: row.public_reason, lastError: row.last_error };
    const review = reviews.get(row.id);
    // New evidence invalidates an automatic approval immediately. A later manual version is an
    // explicit override until the evidence changes and the worker evaluates it again.
    if (review?.output && review.applied_version === row.version && review.inputs_hash !== reviewHash(view)) view.reviewStatus = 'pending';
    return {...view, analysis: currentAnalysis(view, saved.get(row.id)), autoReviewError: review?.last_error ?? null,
      autoReview: review?.output && review.reviewed_at && review.model ? {decision: review.output.decision,
        reason: review.output.reason, reviewedAt: review.reviewed_at.toISOString(), model: review.model} : null};
  });
}

function publicProject(row: FundingAdminProject): FundingProject {
  const { reviewStatus: _review, version: _version, rootdataId: _id, publicReason: _reason, lastError: _error, autoReview: _auto, autoReviewError: _autoError, ...value } = row;
  return value;
}

export async function listFundingProjects(options: { limit?: number; offset?: number; q?: string; tag?: string; id?: number } = {}): Promise<FundingProjectList> {
  const rows = await sql<ProjectRow[]>`SELECT * FROM rootdata_projects
    WHERE review_status = 'approved' AND tracking_status = 'watching'
      ${options.id ? sql`AND id = ${options.id}` : sql``}
    ORDER BY updated_at DESC, id DESC`;
  const q = (options.q ?? "").trim().toLocaleLowerCase();
  const current = (await projectViews(rows)).filter((p) => p.reviewStatus === 'approved' && p.evidence.some((e) => e.kind === "funding")
    && (!q || `${p.name} ${p.description}`.toLocaleLowerCase().includes(q))
    && (!options.tag || p.tags.includes(options.tag)))
    .sort((a, b) => b.lastNewsAt.localeCompare(a.lastNewsAt) || b.id - a.id);
  const offset = Math.max(0, options.offset ?? 0);
  return { items: current.slice(offset, offset + Math.min(100, Math.max(1, options.limit ?? 40))).map(publicProject), total: current.length, notice: FUNDING_NOTICE };
}

export async function fundingProject(id: number): Promise<FundingProject | null> {
  return (await listFundingProjects({ id, limit: 1 })).items[0] ?? null;
}
