// Read-only quality evidence. An article belongs to its current source and discovery-time cohort;
// repeated fetches are not repeated news, and unfinished analysis/grouping is not a failed judgement.
import type { AdminSourceQuality, SourceQualityWindow } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { seatedCondition } from "../publication/scope.ts";
import { budgetMessage } from "../providers/receipts.ts";

const emptyQuality = (): AdminSourceQuality => ({
  received: 0, processed: 0, effective: 0, blocked: 0, pending: 0, failed: 0, backfill: 0,
  pendingGrouping: 0, selectionEvaluated: 0, selected: 0, duplicateEvaluated: 0, duplicates: 0,
  fetchOk: 0, fetchFailed: 0, fetchRunning: 0, budgetSkipped: 0, fetchP95Ms: null,
  effectiveRate: null, selectedRate: null, duplicateRate: null, fetchSuccessRate: null,
});
const rate = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;

/** All matching sources are measured before the admin list sorts and paginates them. */
export async function sourceQuality(sourceIds: string[], days: SourceQualityWindow, observedAt: Date): Promise<Map<string, AdminSourceQuality>> {
  const quality = new Map(sourceIds.map(id => [id, emptyQuality()]));
  if (!sourceIds.length) return quality;
  const since = new Date(observedAt.getTime() - days * 86400_000);
  const spentBudget = budgetMessage("%", "%");
  const [articles, runs] = await Promise.all([
    sql<Array<{ source_id: string } & Pick<AdminSourceQuality, "received" | "processed" | "effective" | "blocked" | "pending" | "failed" | "backfill" | "pendingGrouping" | "selectionEvaluated" | "selected" | "duplicateEvaluated" | "duplicates">>>`
      WITH cohort AS MATERIALIZED (
        SELECT a.id,a.source_id,a.discovered_at,a.revision,a.backfill,a.processing_state,a.grouping_status,
          an.id AS analysis_id,an.relevance,an.output->>'scope' AS scope,
          a.processing_state IN ('analyzed','blocked','skipped') AND an.relevance IN ('pass','block') AS processed
        FROM articles a
        LEFT JOIN LATERAL (
          SELECT id,relevance,output FROM analyses WHERE article_id=a.id AND input_revision=a.revision ORDER BY id DESC LIMIT 1
        ) an ON true
        WHERE a.source_id=ANY(${sourceIds}::text[]) AND a.discovered_at >= ${since} AND a.discovered_at <= ${observedAt}
      ), candidate_facts AS MATERIALIZED (
        SELECT DISTINCT fa.fact_id FROM cohort c
        JOIN fact_articles fa ON fa.article_id=c.id JOIN facts f ON f.id=fa.fact_id
        LEFT JOIN stories st ON st.id=f.story_id
        WHERE c.processed AND c.relevance='pass' AND NOT c.backfill AND c.grouping_status='complete'
          AND c.scope IS DISTINCT FROM 'composite' AND fa.role IN ('primary','report')
          AND (st.id IS NULL OR st.merged_into IS NULL)
      ), related_articles AS MATERIALIZED (
        SELECT DISTINCT fa.article_id FROM candidate_facts cf JOIN fact_articles fa ON fa.fact_id=cf.fact_id
        WHERE fa.role IN ('primary','report')
      ), memberships AS MATERIALIZED (
        -- Only inspect reports of this cohort's facts, but check all their current memberships
        -- so a second fact still disqualifies ambiguous reports, including historical first reports.
        SELECT fa.article_id,min(fa.fact_id) AS fact_id
        FROM related_articles ra JOIN fact_articles fa ON fa.article_id=ra.article_id
        JOIN facts f ON f.id=fa.fact_id LEFT JOIN stories st ON st.id=f.story_id
        WHERE fa.role IN ('primary','report') AND (st.id IS NULL OR st.merged_into IS NULL)
        GROUP BY fa.article_id HAVING count(DISTINCT fa.fact_id)=1
      ), evaluated AS MATERIALIZED (
        SELECT c.id,c.source_id,m.fact_id
        FROM cohort c JOIN memberships m ON m.article_id=c.id
        WHERE c.processed AND c.relevance='pass' AND NOT c.backfill AND c.grouping_status='complete'
          AND c.scope IS DISTINCT FROM 'composite'
      ), first_reports AS (
        -- The first eligible report is global and may predate this window or come from another source.
        SELECT DISTINCT ON (m.fact_id) m.fact_id,a.id
        FROM memberships m JOIN articles a ON a.id=m.article_id
        JOIN (SELECT DISTINCT fact_id FROM evaluated) relevant ON relevant.fact_id=m.fact_id
        JOIN LATERAL (
          SELECT relevance,output FROM analyses WHERE article_id=a.id AND input_revision=a.revision ORDER BY id DESC LIMIT 1
        ) an ON true
        WHERE NOT a.backfill AND a.grouping_status='complete' AND a.processing_state IN ('analyzed','blocked','skipped')
          AND an.relevance='pass' AND an.output->>'scope' IS DISTINCT FROM 'composite' AND a.discovered_at <= ${observedAt}
        ORDER BY m.fact_id,a.discovered_at,a.id
      )
      SELECT c.source_id,count(*)::int AS received,
        count(*) FILTER (WHERE c.processed)::int AS processed,
        count(*) FILTER (WHERE c.processed AND c.relevance='pass')::int AS effective,
        count(*) FILTER (WHERE c.processed AND c.relevance='block')::int AS blocked,
        count(*) FILTER (WHERE NOT coalesce(c.processed,false) AND c.processing_state <> 'failed')::int AS pending,
        count(*) FILTER (WHERE c.processing_state='failed')::int AS failed,
        count(*) FILTER (WHERE c.backfill)::int AS backfill,
        count(*) FILTER (WHERE c.processed AND c.relevance='pass' AND c.grouping_status <> 'complete')::int AS "pendingGrouping",
        count(*) FILTER (WHERE c.processed AND (c.relevance='block' OR c.grouping_status='complete'))::int AS "selectionEvaluated",
        count(*) FILTER (WHERE c.processed AND c.relevance='pass' AND c.grouping_status='complete'
          AND p.revision=c.revision AND p.analysis_id=c.analysis_id AND ${seatedCondition(observedAt)})::int AS selected,
        count(e.id)::int AS "duplicateEvaluated",count(e.id) FILTER (WHERE first.id <> e.id)::int AS duplicates
      FROM cohort c LEFT JOIN publications p ON p.article_id=c.id
        LEFT JOIN evaluated e ON e.id=c.id LEFT JOIN first_reports first ON first.fact_id=e.fact_id
      GROUP BY c.source_id`,
    sql<Array<{ source_id: string } & Pick<AdminSourceQuality, "fetchOk" | "fetchFailed" | "fetchRunning" | "budgetSkipped" | "fetchP95Ms">>>`
      SELECT source_id,
        count(*) FILTER (WHERE status='ok' AND coalesce(error,'') NOT LIKE ${spentBudget})::int AS "fetchOk",
        count(*) FILTER (WHERE status='failed' AND coalesce(error,'') NOT LIKE ${spentBudget})::int AS "fetchFailed",
        count(*) FILTER (WHERE status='running')::int AS "fetchRunning",
        count(*) FILTER (WHERE status='failed' AND coalesce(error,'') LIKE ${spentBudget})::int AS "budgetSkipped",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at-started_at))*1000)
          FILTER (WHERE status IN ('ok','failed') AND coalesce(error,'') NOT LIKE ${spentBudget}
            AND finished_at IS NOT NULL AND finished_at >= started_at) AS "fetchP95Ms"
      FROM fetch_runs WHERE source_id=ANY(${sourceIds}::text[]) AND started_at >= ${since} AND started_at <= ${observedAt}
      GROUP BY source_id`,
  ]);
  for (const row of [...articles, ...runs]) {
    const { source_id, ...counts } = row;
    Object.assign(quality.get(source_id)!, counts);
  }
  for (const item of quality.values()) {
    item.fetchP95Ms = item.fetchP95Ms === null ? null : Math.round(item.fetchP95Ms);
    item.effectiveRate = rate(item.effective, item.processed);
    item.selectedRate = rate(item.selected, item.selectionEvaluated);
    item.duplicateRate = rate(item.duplicates, item.duplicateEvaluated);
    item.fetchSuccessRate = rate(item.fetchOk, item.fetchOk + item.fetchFailed);
  }
  return quality;
}
