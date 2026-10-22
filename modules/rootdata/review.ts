import { sql } from '@aihot/backend/db';
import { audit } from '@aihot/backend/audit';
import { modelFor } from '@aihot/backend/editorial/models';
import { chatJson, MODELS } from '@aihot/backend/providers/llm';
import { completeReceipt, rejectReceivedResponse, failureKind, failedReceiptId } from '@aihot/backend/providers/receipts';
import { logTaskError } from '@aihot/backend/lib/log-error';
import { projectViews, type ProjectRow } from './publication.ts';
import { normalizedProjectName } from './rules.ts';
import { REVIEW_SYSTEM, REVIEW_VERSION, ReviewSchema, reviewHash, reviewInputs, validateReview, type ReviewOutput } from './review-content.ts';
import type { FundingAdminProject } from './contracts.ts';

export interface SavedReview {
  inputs_hash: string | null; attempt_hash: string; output: ReviewOutput | null; reviewed_at: Date | null;
  model: string | null; applied_version: number | null; next_attempt_at: Date; last_error: string | null;
}
export type ReviewModel = (project: FundingAdminProject) => Promise<{data: unknown; receiptId: number | null; model: string}>;
const review: ReviewModel = async project => chatJson({
  model: await modelFor('rootdataReview'), purpose: 'rootdata_project_review', subject: `rootdata:${project.id}`,
  promptVersion: REVIEW_VERSION, system: REVIEW_SYSTEM, user: JSON.stringify(reviewInputs(project)),
  schema: ReviewSchema, temperature: 0.2, maxTokens: 2400,
});

export async function reviewFundingProjects(ask: ReviewModel = review): Promise<{status: 'ok' | 'failed' | 'skipped'; updated: number; failed: number; skipped?: string}> {
  if (process.env.MODEL_CALLS_ENABLED !== 'true') return {status: 'skipped', updated: 0, failed: 0, skipped: 'models_disabled'};
  const connection = await sql.reserve();
  let locked = false, updated = 0, failed = 0;
  try {
    [{locked}] = await connection<{locked: boolean}[]>`SELECT pg_try_advisory_lock(hashtext('rootdata.review')) AS locked`;
    if (!locked) return {status: 'skipped', updated, failed, skipped: 'already_running'};
    const rows = await sql<ProjectRow[]>`SELECT p.* FROM rootdata_projects p LEFT JOIN rootdata_reviews r ON r.project_id=p.id
      WHERE p.tracking_status='watching' ORDER BY r.reviewed_at NULLS FIRST, r.next_attempt_at NULLS FIRST, p.created_at DESC, p.id DESC`;
    const saved = new Map((await sql<(SavedReview & {project_id: number})[]>`SELECT * FROM rootdata_reviews`).map(r => [r.project_id, r]));
    let calls = 0;
    for (const project of await projectViews(rows)) {
      if (!project.evidence.some(e => e.kind === 'funding')) continue;
      const hash = reviewHash(project), previous = saved.get(project.id);
      if (previous?.output && previous.inputs_hash === hash) continue;
      if (previous?.attempt_hash === hash && previous.next_attempt_at > new Date()) continue;
      if (calls++ >= 6) break;
      await sql`INSERT INTO rootdata_reviews (project_id, attempt_hash, next_attempt_at)
        VALUES (${project.id}, ${hash}, now() + interval '1 hour') ON CONFLICT (project_id)
        DO UPDATE SET attempt_hash=EXCLUDED.attempt_hash, next_attempt_at=EXCLUDED.next_attempt_at`;
      let stage = 'model', receiptId: number | null = null;
      try {
        const result = await ask(project);
        receiptId = result.receiptId;
        stage = 'validation';
        let output: ReviewOutput;
        try { output = validateReview(result.data, project); }
        catch (error) {
          if (receiptId !== null) await rejectReceivedResponse(receiptId, 'Project review failed evidence validation');
          throw error;
        }
        stage = 'commit';
        const applied = await sql.begin(async tx => {
          const [before] = await tx<ProjectRow[]>`SELECT * FROM rootdata_projects WHERE id=${project.id} FOR UPDATE`;
          const current = before ? (await projectViews([before], tx))[0] : undefined;
          if (!current || before.tracking_status !== 'watching' || reviewHash(current) !== hash) {
            if (receiptId !== null) await completeReceipt(tx, receiptId);
            return false;
          }
          if (before.version !== project.version) {
            // A manual decision made during the request wins for these same facts too, not just
            // until the next schedule. Retain the paid judgement without applying its status.
            await tx`UPDATE rootdata_reviews SET inputs_hash=${hash}, output=${tx.json(output)},
              model=${MODELS[result.model]?.model || result.model}, receipt_id=${receiptId}, reviewed_at=now(),
              applied_version=NULL, last_error=NULL WHERE project_id=${project.id}`;
            await audit('rootdata:auto-review', 'rootdata.auto_review_superseded', `rootdata:${project.id}`,
              '审核期间管理员已修改项目，保留当前人工决定，资料变化后再自动审核。',
              {version: project.version}, {version: before.version, receiptId, decision: output.decision}, {db: tx});
            if (receiptId !== null) await completeReceipt(tx, receiptId);
            return false;
          }
          let name = output.canonicalName ?? before.name;
          let renamed = name !== before.name;
          const apply = async (db: typeof tx) => (await db<ProjectRow[]>`UPDATE rootdata_projects SET
            name=${name}, name_key=${normalizedProjectName(name)},
            rootdata_id=${renamed ? null : before.rootdata_id}, profile=${renamed ? null : before.profile ? db.json(before.profile as never) : null},
            profile_updated_at=${renamed ? null : before.profile_updated_at}, next_refresh_at=${renamed ? new Date() : before.next_refresh_at},
            last_error=${renamed ? null : before.last_error},
            review_status=${output.decision === 'approve' ? 'approved' : output.decision === 'reject' ? 'rejected' : 'pending'},
            public_reason=${output.decision === 'approve' ? output.reason : ''}, version=version+1, updated_at=now()
            WHERE id=${project.id} RETURNING *`)[0]!;
          let after: ProjectRow;
          try { after = await tx.savepoint(apply); }
          catch (error) {
            if ((error as {code?: string}).code !== '23505' || !renamed) throw error;
            output = {...output, decision: 'defer', reason: `新闻主体“${name}”已有关联候选，暂缓发布以避免重复或错误合并。`};
            name = before.name;
            renamed = false;
            after = await apply(tx);
          }
          const finalView = (await projectViews([after], tx))[0]!;
          await tx`UPDATE rootdata_reviews SET inputs_hash=${reviewHash(finalView)}, attempt_hash=${reviewHash(finalView)},
            output=${tx.json(output)}, model=${MODELS[result.model]?.model || result.model}, receipt_id=${receiptId},
            reviewed_at=now(), applied_version=${after.version}, next_attempt_at=now(), last_error=NULL WHERE project_id=${project.id}`;
          await audit('rootdata:auto-review', 'rootdata.auto_review', `rootdata:${project.id}`, output.reason,
            {name: before.name, reviewStatus: before.review_status, version: before.version},
            {name: after.name, reviewStatus: after.review_status, version: after.version, decision: output.decision, receiptId, inputsHash: reviewHash(finalView)}, {db: tx});
          if (receiptId !== null) await completeReceipt(tx, receiptId);
          return true;
        });
        if (applied) updated++;
      } catch (error) {
        failed++;
        logTaskError(error, {msg: 'funding review failed', job: 'rootdata.review', projectId: project.id, stage,
          kind: failureKind(error), receiptId: receiptId ?? failedReceiptId(error), level: failureKind(error) === 'budget' ? 'warn' : 'error'});
        await sql`UPDATE rootdata_reviews SET last_error='自动审核暂未完成，稍后重试；请检查模型回执和预算' WHERE project_id=${project.id}`;
      }
    }
    return {status: failed ? 'failed' : 'ok', updated, failed};
  } finally {
    try { if (locked) await connection`SELECT pg_advisory_unlock(hashtext('rootdata.review'))`; }
    finally { connection.release(); }
  }
}
