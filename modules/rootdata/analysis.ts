import { sql } from '@aihot/backend/db';
import { modelFor } from '@aihot/backend/editorial/models';
import { chatJson, MODELS } from '@aihot/backend/providers/llm';
import { completeReceipt, rejectReceivedResponse, failureKind, failedReceiptId } from '@aihot/backend/providers/receipts';
import { logTaskError } from '@aihot/backend/lib/log-error';
import { projectViews, type ProjectRow } from './publication.ts';
import { ANALYSIS_SYSTEM, ANALYSIS_VERSION, AnalysisSchema, analysisHash, analysisInputs, analysisSources, validateAnalysis } from './analysis-content.ts';

export type AnalysisModel = (project: Awaited<ReturnType<typeof projectViews>>[number]) => Promise<{data: unknown; receiptId: number | null; model: string}>;
const analyze: AnalysisModel = async project => chatJson({
  model: await modelFor('rootdataAnalysis'), purpose: 'rootdata_project_analysis', subject: `rootdata:${project.id}`,
  promptVersion: ANALYSIS_VERSION, system: ANALYSIS_SYSTEM, user: JSON.stringify({...analysisInputs(project), sources: Object.fromEntries(analysisSources(project))}),
  schema: AnalysisSchema, temperature: 0.2, maxTokens: 3500,
});

export async function analyzeFundingProjects(ask: AnalysisModel = analyze): Promise<{status: 'ok' | 'failed' | 'skipped'; updated: number; failed: number; skipped?: string}> {
  if (process.env.MODEL_CALLS_ENABLED !== 'true') return {status: 'skipped', updated: 0, failed: 0, skipped: 'models_disabled'};
  const connection = await sql.reserve();
  let locked = false;
  let updated = 0, failed = 0;
  try {
    [ {locked} ] = await connection<{locked: boolean}[]>`SELECT pg_try_advisory_lock(hashtext('rootdata.analysis')) AS locked`;
    if (!locked) return {status: 'skipped', updated, failed, skipped: 'already_running'};
    const rows = await sql<ProjectRow[]>`SELECT p.* FROM rootdata_projects p LEFT JOIN rootdata_analyses a ON a.project_id = p.id
      WHERE p.review_status = 'approved' AND p.tracking_status = 'watching'
        AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= now())
      ORDER BY a.generated_at NULLS FIRST, p.id`;
    let attempts = 0;
    for (const project of await projectViews(rows)) {
      if (project.reviewStatus !== 'approved' || !project.evidence.some(e => e.kind === 'funding') || project.analysis) continue;
      if (attempts++ >= 3) break;
      const hash = analysisHash(project);
      // At most three projects per schedule, with existing service budgets and durable paid receipts.
      await sql`INSERT INTO rootdata_analyses (project_id, inputs_hash, next_attempt_at) VALUES (${project.id}, ${hash}, now() + interval '1 hour')
        ON CONFLICT (project_id) DO UPDATE SET next_attempt_at = EXCLUDED.next_attempt_at`;
      let stage = 'model';
      let receiptId: number | null = null;
      try {
        const result = await ask(project);
        receiptId = result.receiptId;
        stage = 'validation';
        let output;
        try { output = validateAnalysis(result.data, project); }
        catch (error) {
          if (result.receiptId !== null) await rejectReceivedResponse(result.receiptId, 'Project analysis failed evidence validation');
          throw error;
        }
        stage = 'commit';
        const stored = await sql.begin(async tx => {
          const [row] = await tx<ProjectRow[]>`SELECT * FROM rootdata_projects WHERE id = ${project.id} FOR UPDATE`;
          const current = row ? (await projectViews([row], tx))[0] : undefined;
          if (!current || current.reviewStatus !== 'approved' || row.tracking_status !== 'watching' || analysisHash(current) !== hash) {
            if (result.receiptId !== null) await completeReceipt(tx, result.receiptId);
            return false;
          }
          await tx`UPDATE rootdata_analyses SET inputs_hash = ${hash}, output = ${tx.json(output)}, generated_at = now(),
            model = ${MODELS[result.model]?.model || result.model}, receipt_id = ${result.receiptId}, last_error = NULL, next_attempt_at = now()
            WHERE project_id = ${project.id}`;
          if (result.receiptId !== null) await completeReceipt(tx, result.receiptId);
          return true;
        });
        if (stored) updated++;
      } catch (error) {
        failed++;
        logTaskError(error, { msg: 'funding analysis failed', job: 'rootdata.analysis', projectId: project.id, stage,
          kind: failureKind(error), receiptId: receiptId ?? failedReceiptId(error), level: failureKind(error) === 'budget' ? 'warn' : 'error' });
        await sql`UPDATE rootdata_analyses SET last_error = '分析暂未完成；请检查模型运行回执与预算，稍后重试' WHERE project_id = ${project.id}`;
      }
    }
    return {status: failed ? 'failed' : 'ok', updated, failed};
  } finally {
    try {
      if (locked) await connection`SELECT pg_advisory_unlock(hashtext('rootdata.analysis'))`;
    } finally {
      connection.release();
    }
  }
}
