import '../../../tests/setup.ts';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {sql, closeDb} from '@aihot/backend/db';
import {recordRun} from '@aihot/backend/jobs/queue';
import {analyzeFundingProjects, type AnalysisModel} from '../analysis.ts';
import {fundingProject} from '../publication.ts';
import {discoverFundingCandidates, updateFundingProject} from '../tracking.ts';
import {reviewFundingProjects, type ReviewModel} from '../review.ts';

after(closeDb);
async function create(name: string) {
  const id = `rd-analysis-${name.toLowerCase()}`;
  await sql`INSERT INTO sources (id, name, kind) VALUES (${id}, 'Public News', 'rss')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at)
    VALUES (${id}, ${id}, ${id}, ${`https://example.org/${id}`}, ${`${name} raises $10 million`}, now(), now(), now())`;
  await sql`INSERT INTO publications (article_id, title, summary, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at, eligible, selected)
    VALUES (${id}, ${`${name} raises $10 million`}, 'The company plans to launch a data network.', ${id}, 'news', ${`https://example.org/${id}`}, now(), now(), now(), now(), true, false)`;
  await discoverFundingCandidates();
  const [row] = await sql`SELECT id, version FROM rootdata_projects WHERE name = ${name}`;
  await updateFundingProject(row.id, {version: row.version, reason: 'Checked original report', publicReason: 'Follow the announced data network', reviewStatus: 'approved'}, 'test-admin');
  return {id: row.id as number, articleId: id};
}
const answer: AnalysisModel = async project => {
  const claim = {text: 'The product still needs evidence of adoption.', kind: 'assessment', citations: [{sourceId: project.evidence[0].articleId, quote: 'The company plans to launch a data network.'}]};
  return {receiptId: null, model: 'deepseek-flash-test', data: {confidence: 'low', whatItDoes: {...claim, kind: 'fact', text: 'Plans a data network'}, chainAssessment: {text: '未确认所在链', kind: 'unknown', citations: []}, promotionAssessment: claim, outlook: claim, opportunities: [claim], risks: [claim], watchSignals: ['Verify product launch and usage.']}};
};
test('analysis is cached, grounded in current evidence, and generation respects the model valve', async () => {
  const item = await create('AnalysisAlpha');
  let calls = 0;
  const ask: AnalysisModel = async project => {calls++; return answer(project);};
  process.env.MODEL_CALLS_ENABLED = 'false';
  assert.equal((await analyzeFundingProjects(ask)).skipped, 'models_disabled');
  assert.equal(calls, 0);
  process.env.MODEL_CALLS_ENABLED = 'true';
  assert.equal((await analyzeFundingProjects(ask)).updated, 1);
  assert.equal((await fundingProject(item.id))?.analysis?.model, 'deepseek-flash-test');
  assert.equal((await analyzeFundingProjects(ask)).updated, 0);
  assert.equal(calls, 1);
  await sql`UPDATE publications SET summary = 'The financing report was corrected.', revision = revision + 1 WHERE article_id = ${item.articleId}`;
  assert.equal(await fundingProject(item.id), null);
});

test('one failed project logs its cause and does not block the next analysis', async t => {
  // The earlier correction fixture is intentionally stale; this run exercises only these two projects.
  await sql`UPDATE rootdata_projects SET tracking_status='paused'`;
  const failed = await create('AnalysisFailed');
  const next = await create('AnalysisNext');
  const logs = t.mock.method(console, 'error', () => {});
  const result = await recordRun('rootdata.analysis', () => analyzeFundingProjects(async project => {
    if (project.id === failed.id) throw new Error('synthetic model transport failure');
    return answer(project);
  }));
  assert.equal(result.failed, 1);
  assert.equal(result.updated, 1);
  const [run] = await sql`SELECT status FROM job_runs WHERE job='rootdata.analysis' ORDER BY id DESC LIMIT 1`;
  assert.equal(run.status, 'failed');
  assert.ok((await fundingProject(next.id))?.analysis);
  const entry = logs.mock.calls.map(c => JSON.parse(String(c.arguments[0]))).find(e => e.projectId === failed.id);
  assert.equal(entry.job, 'rootdata.analysis');assert.equal(entry.stage, 'model');
  assert.equal(entry.err.message, 'synthetic model transport failure');assert.match(entry.err.stack, /at /);
  const [row] = await sql`SELECT last_error,next_attempt_at FROM rootdata_analyses WHERE project_id=${failed.id}`;
  assert.ok(row.last_error);assert.ok(row.next_attempt_at > new Date());
});
test('a withdrawal while the model is running cannot publish the now unsupported analysis', async () => {
  const item = await create('AnalysisBeta');
  const result = await analyzeFundingProjects(async project => {
    await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${item.articleId}`;
    return answer(project);
  });
  assert.equal(result.updated, 0);
  assert.equal(await fundingProject(item.id), null);
  const [row] = await sql`SELECT output FROM rootdata_analyses WHERE project_id = ${item.id}`;
  assert.equal(row.output, null);
});

test('analysis returns its reserved connection even when unlock fails', async t => {
  let queries=0,released=0;
  const failure=new Error('analysis unlock connection lost');
  const connection=Object.assign(async()=>{if(++queries>1)throw failure;return [{locked:true}];},{release:()=>{released++;}});
  const mocked=t.mock.method(sql,'reserve',async()=>connection as unknown as Awaited<ReturnType<typeof sql.reserve>>);
  try{await assert.rejects(analyzeFundingProjects(answer),error=>error===failure);}finally{mocked.mock.restore();}
  assert.equal(released,1);
});

test('changed evidence waits for automatic review before regenerating its public analysis', async () => {
  await sql`UPDATE rootdata_projects SET tracking_status='paused'`;
  process.env.MODEL_CALLS_ENABLED = 'true';
  const item = await create('AutomaticRefresh');
  const review: ReviewModel = async project => ({receiptId: null, model: 'review-test', data: {
    decision: 'approve', reason: 'Follow the announced data network and launch milestones.',
    identityMatched: true, fundingConfirmed: true, canonicalName: null,
    citations: [{sourceId: item.articleId, quote: project.evidence.find(e => e.articleId === item.articleId)!.title}],
  }});
  await reviewFundingProjects(review);
  assert.equal((await analyzeFundingProjects(answer)).updated, 1);
  assert.ok((await fundingProject(item.id))?.analysis);
  await sql`UPDATE publications SET summary=summary || ' New product launch milestones were announced.', revision=revision+1
    WHERE article_id=${item.articleId}`;
  await discoverFundingCandidates();
  assert.equal(await fundingProject(item.id), null, 'the old automatic approval cannot publish changed evidence');
  let calls = 0;
  const ask: AnalysisModel = async project => {calls++; return answer(project);};
  assert.equal((await analyzeFundingProjects(ask)).updated, 0);
  assert.equal(calls, 0, 'analysis waits for the review of the new input');
  assert.equal((await reviewFundingProjects(review)).updated, 1);
  assert.equal((await analyzeFundingProjects(ask)).updated, 1);
  assert.ok((await fundingProject(item.id))?.analysis);
  assert.equal((await analyzeFundingProjects(ask)).updated, 0);
  assert.equal(calls, 1, 'the refreshed analysis is cached');
});
