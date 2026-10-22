import '../../../tests/setup.ts';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {sql, closeDb} from '@aihot/backend/db';
import {analyzeFundingProjects, type AnalysisModel} from '../analysis.ts';
import {fundingProject} from '../publication.ts';
import {discoverFundingCandidates, updateFundingProject} from '../tracking.ts';

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
