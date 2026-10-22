import {stub, tag, pointModels} from '../../../tests/setup.ts';
import {test, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {sql, closeDb} from '@aihot/backend/db';
import {installModules} from '@aihot/backend/modules';
import {paidRequest} from '@aihot/backend/providers/receipts';
import {reviewFundingProjects, type ReviewModel} from '../review.ts';
import {reviewHash, type ReviewOutput} from '../review-content.ts';
import {fundingProject, projectViews, type ProjectRow} from '../publication.ts';
import {updateFundingProject} from '../tracking.ts';
import rootdataServer from '../server.ts';

after(closeDb);
beforeEach(async () => {
  process.env.MODEL_CALLS_ENABLED = 'true';
  await sql`UPDATE rootdata_projects SET tracking_status='paused'`;
});
async function create(name: string, title = `${name} raises $10 million to build a data network`) {
  const articleId = `review-${tag()}`;
  await sql`INSERT INTO sources (id,name,kind) VALUES (${articleId},'Public News','rss')`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at)
    VALUES (${articleId},${articleId},${articleId},${`https://example.org/${articleId}`},${title},now(),now(),now())`;
  const [pub] = await sql`INSERT INTO publications (article_id,title,summary,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,eligible,selected)
    VALUES (${articleId},${title},'A developer data network is due to launch.',${articleId},'news',${`https://example.org/${articleId}`},now(),now(),now(),now(),true,false) RETURNING revision`;
  const [row] = await sql<ProjectRow[]>`INSERT INTO rootdata_projects (name,name_key) VALUES (${name},${name.toLowerCase()}) RETURNING *`;
  await sql`INSERT INTO rootdata_evidence (project_id,article_id,kind,publication_revision) VALUES (${row!.id},${articleId},'funding',${pub!.revision})`;
  return {id: row!.id, articleId};
}
async function view(id: number) { return (await projectViews(await sql<ProjectRow[]>`SELECT * FROM rootdata_projects WHERE id=${id}`))[0]!; }
function answer(project: Parameters<ReviewModel>[0], decision: ReviewOutput['decision'] = 'approve', canonicalName: string | null = null) {
  const citation = {sourceId: project.evidence[0]!.articleId, quote: project.evidence[0]!.title};
  return {receiptId: null, model: 'test-review', data: {decision, reason: decision === 'approve' ? '融资用于开发者数据网络，继续核验产品交付。' : '现有资料不足以确认业务后续进展。',
    identityMatched: true, fundingConfirmed: true, canonicalName, nameCitation: canonicalName ? citation : null, citations: [citation]}};
}

test('automatic approval publishes without manual review and pauses are preserved', async () => {
  const item = await create(`Automatic${tag()}`);
  let calls = 0;
  const ask: ReviewModel = async p => {calls++; return answer(p);};
  process.env.MODEL_CALLS_ENABLED = 'false';
  assert.equal((await reviewFundingProjects(ask)).skipped, 'models_disabled');
  assert.equal(calls, 0);
  process.env.MODEL_CALLS_ENABLED = 'true';
  assert.equal((await reviewFundingProjects(ask)).updated, 1);
  assert.equal((await fundingProject(item.id))?.profileStatus, 'pending');
  assert.equal((await view(item.id)).autoReview?.decision, 'approve');
  assert.equal('autoReview' in (await fundingProject(item.id))!, false);
  assert.equal((await reviewFundingProjects(ask)).updated, 0);
  assert.equal(calls, 1);
  await sql`UPDATE rootdata_projects SET tracking_status='paused' WHERE id=${item.id}`;
  await reviewFundingProjects(ask);
  assert.equal(calls, 1);
  assert.equal(await fundingProject(item.id), null);
  const [audited] = await sql`SELECT action FROM audit_log WHERE subject=${`rootdata:${item.id}`} AND actor='rootdata:auto-review'`;
  assert.equal(audited?.action, 'rootdata.auto_review');
});

test('defer and reject are cached until facts change, then a new automatic judgement can approve', async () => {
  const deferred = await create(`Deferred${tag()}`), rejected = await create(`Rejected${tag()}`);
  let calls = 0;
  await reviewFundingProjects(async p => {calls++; return answer(p, p.id === deferred.id ? 'defer' : 'reject');});
  assert.equal((await view(deferred.id)).reviewStatus, 'pending');
  assert.equal((await view(rejected.id)).reviewStatus, 'rejected');
  await reviewFundingProjects(async p => {calls++; return answer(p);});
  assert.equal(calls, 2);
  await sql`UPDATE publications SET summary='The developer data network launched with a documented API.' WHERE article_id=${deferred.articleId}`;
  await reviewFundingProjects(async p => {calls++; return answer(p);});
  assert.equal(calls, 3);
  assert.ok(await fundingProject(deferred.id));
  assert.equal(await fundingProject(rejected.id), null);
});

test('canonical name correction clears mismatched RootData identity without a repeat-review loop; collisions defer', async () => {
  const canonical = `Navra${tag()}`;
  const item = await create(`Founder for ${canonical}`, `SoFi 联合创始人为 ${canonical} 融资 1900 万美元`);
  await sql`UPDATE rootdata_projects SET rootdata_id=911, profile=${sql.json({projectId: 911, name: 'Wrong', description: 'Wrong company profile', tags: []})}, profile_updated_at=now() WHERE id=${item.id}`;
  let calls = 0;
  await reviewFundingProjects(async p => {calls++; return answer(p, 'approve', canonical);});
  const renamed = await view(item.id);
  assert.equal(renamed.name, canonical);
  assert.equal(renamed.rootdataId, null);
  assert.equal(renamed.profileStatus, 'pending');
  assert.ok(await fundingProject(item.id));
  await reviewFundingProjects(async p => {calls++; return answer(p, 'approve', canonical);});
  assert.equal(calls, 1);
  const duplicate = await create(`Investor backed ${canonical}`, `${canonical} raises $12 million for a developer network`);
  await reviewFundingProjects(async p => {calls++; return answer(p, 'approve', canonical);});
  assert.equal((await view(duplicate.id)).autoReview?.decision, 'defer');
  assert.match((await view(duplicate.id)).autoReview!.reason, /重复/);
  assert.equal(await fundingProject(duplicate.id), null);
  assert.ok(await fundingProject(item.id));
});

test('changed evidence immediately hides an automatic approval and re-evaluates; withdrawal during the model call cannot publish', async () => {
  const item = await create(`Recheck${tag()}`);
  await reviewFundingProjects(async p => answer(p));
  await sql`UPDATE publications SET summary='The launch was delayed, so delivery still needs checking.' WHERE article_id=${item.articleId}`;
  assert.equal(await fundingProject(item.id), null);
  assert.equal((await view(item.id)).reviewStatus, 'pending');
  await reviewFundingProjects(async p => answer(p));
  assert.ok(await fundingProject(item.id));
  const withdrawn = await create(`Withdrawn${tag()}`);
  assert.equal((await reviewFundingProjects(async p => {
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${withdrawn.articleId}`;
    return answer(p);
  })).updated, 0);
  assert.equal(await fundingProject(withdrawn.id), null);
  assert.equal((await view(withdrawn.id)).autoReview, null);
});

test('manual decisions during a model request win for unchanged facts and later evidence triggers automatic review', async () => {
  const item = await create(`Manual${tag()}`);
  let calls = 0;
  await reviewFundingProjects(async p => {
    calls++;
    await updateFundingProject(p.id, {version: p.version, reason: 'An operator deferred the item', reviewStatus: 'rejected'}, 'test-admin');
    return answer(p);
  });
  assert.equal((await view(item.id)).reviewStatus, 'rejected');
  await sql`UPDATE rootdata_reviews SET next_attempt_at=now()-interval '1 minute' WHERE project_id=${item.id}`;
  await reviewFundingProjects(async p => {calls++; return answer(p);});
  assert.equal(calls, 1);
  await sql`UPDATE publications SET summary='The API is now live and documents the developer product.' WHERE article_id=${item.articleId}`;
  await reviewFundingProjects(async p => {calls++; return answer(p);});
  assert.equal(calls, 2);
  assert.ok(await fundingProject(item.id));
});

test('at most six candidates invoke the model per schedule; a failed item backs off without blocking the next', async t => {
  t.mock.method(console, 'error', () => {});
  const items = [];
  for (let i=0; i<8; i++) items.push(await create(`Batch${i}${tag()}`));
  const newest = items.at(-1)!;
  let calls = 0;
  const result = await reviewFundingProjects(async p => {calls++; if (p.id === newest.id) throw new Error('synthetic transport failure'); return answer(p);});
  assert.equal(calls, 6);
  assert.equal(result.status, 'failed');
  assert.equal(result.failed, 1);
  assert.equal(result.updated, 5);
  const [row] = await sql`SELECT last_error,next_attempt_at FROM rootdata_reviews WHERE project_id=${newest.id}`;
  assert.ok(row.last_error);
  assert.ok(row.next_attempt_at > new Date());
  assert.equal((await reviewFundingProjects(async p => {calls++; return answer(p);})).updated, 2);
  assert.equal(calls, 8);
});

test('the real model adapter reuses received answers after business state is lost, without a second paid attempt', async t => {
  const item = await create(`Receipt${tag()}`);
  const remote = await stub((_hit, req) => {
    const user = JSON.parse(JSON.parse(req.body).messages[1].content);
    return {id: 'review-test-response', choices: [{message: {content: JSON.stringify(answer(user).data)}}]};
  });
  t.after(remote.close);
  installModules([rootdataServer]);
  process.env.ROOTDATA_REVIEW_MODEL='deepseek-flash';
  pointModels(remote.url, ['deepseek-flash']);
  assert.equal((await reviewFundingProjects()).updated, 1);
  await sql`DELETE FROM rootdata_reviews WHERE project_id=${item.id}`;
  assert.equal((await reviewFundingProjects()).updated, 1);
  assert.equal(remote.hits(), 1);
  const [receipt] = await sql`SELECT status,attempts FROM receipts WHERE purpose='rootdata_project_review' AND subject=${`rootdata:${item.id}`}`;
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.attempts, 1);
});

test('unknown provider outcomes remain fenced after the retry delay', async t => {
  t.mock.method(console, 'error', () => {});
  const item = await create(`Unknown${tag()}`);
  let calls = 0;
  const ask: ReviewModel = async p => {
    await paidRequest({service: 'review-test', purpose: 'rootdata_project_review', subject: `rootdata:${p.id}`, identity: reviewHash(p)},
      async () => {calls++; throw new Error('synthetic timeout after dispatch');});
    throw new Error('unreachable');
  };
  await reviewFundingProjects(ask);
  await sql`UPDATE rootdata_reviews SET next_attempt_at=now()-interval '1 minute' WHERE project_id=${item.id}`;
  await reviewFundingProjects(ask);
  assert.equal(calls, 1);
  const [receipt] = await sql`SELECT status,attempts FROM receipts WHERE service='review-test' AND subject=${`rootdata:${item.id}`}`;
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.attempts, 1);
});
