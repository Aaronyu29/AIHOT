import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getProject, getQuota, RootDataError, safeLink, searchProjects, uniqueExactProject} from '../client.ts';

const answer = (data: unknown, result: unknown = 200): typeof fetch => async () => Response.json({result, data});
test('Basic requests use only official endpoints, private headers and no expanded fields', async () => {
  const calls: Array<{url: string; init: RequestInit}> = [];
  const read: typeof fetch = async (url, init) => {
    calls.push({url: String(url), init: init!});
    return Response.json({result: 200, data: {project_id: 12, project_name: 'Sample'}});
  };
  await getProject(12, 'private-test-key', read);
  assert.equal(calls[0]!.url, 'https://api.rootdata.com/open/get_item');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {project_id: 12, include_team: false, include_investors: false});
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal(new Headers(calls[0]!.init.headers).get('apikey'), 'private-test-key');
  assert.equal(new Headers(calls[0]!.init.headers).get('language'), 'cn');
  let hits = 0;
  await assert.rejects(getProject(12, '', async () => { hits++; return Response.json({}); }), /not configured/);
  assert.equal(hits, 0);
});
test('quota is strictly validated and strips the echoed API key', async () => {
  const quota = await getQuota('secret', answer({apikey: 'secret', level: 'Basic', credits: '998', total_credits: 1000, start: 1721750400000, end: 1787846399000}));
  assert.deepEqual(quota, {level: 'basic', credits: 998, totalCredits: 1000, periodStart: 1721750400000, periodEnd: 1787846399000});
  assert.ok(!JSON.stringify(quota).includes('secret'));
  for (const credits of [undefined, null, '', -1, 1.5, 'bad']) {
    await assert.rejects(getQuota('secret', answer({level: 'basic', credits, total_credits: 1000})), /invalid quota/);
  }
});
test('HTTP and business errors are distinct and never echo upstream secrets', async () => {
  await assert.rejects(getQuota('secret', answer({apikey: 'secret'}, 403)), (error: unknown) => error instanceof RootDataError && error.status === 200 && error.code === 403 && !error.message.includes('secret'));
  await assert.rejects(getQuota('secret', async () => new Response('secret', {status: 429})), (error: unknown) => error instanceof RootDataError && error.status === 429 && error.retryable && !error.message.includes('secret'));
  await assert.rejects(getQuota('secret', async () => { throw new Error('secret'); }), /did not complete/);
  await assert.rejects(getQuota('secret', async () => new Response('not JSON')), /invalid JSON/);
});
test('project normalization excludes restricted funding data and preserves missingness', async () => {
  const project = await getProject(12, 'test', answer({project_id: 12, project_name: 'Sample', total_funding: 1234, investors: [{name: 'Never publish'}], social_media: [{website: 'https://sample.example', twitter: 'javascript:alert(1)'}], rootdataurl: 'https://cn.rootdata.com/Projects/detail/Sample?k=MTI=', tags: ['Infra', 'Infra', null, 'ZK']}));
  assert.equal(project.active, null);
  assert.equal(project.twitter, null);
  assert.equal(project.website, 'https://sample.example/');
  assert.deepEqual(project.tags, ['Infra', 'ZK']);
  assert.ok(!JSON.stringify(project).includes('total_funding'));
  assert.ok(!JSON.stringify(project).includes('Never publish'));
  const objectSocial = await getProject(12, 'test', answer({project_id: 12, project_name: 'Sample', social_media: {twitter: 'https://x.com/sample'}}));
  assert.equal(objectSocial.twitter, 'https://x.com/sample');
  await assert.rejects(getProject(12, 'test', answer({project_id: 13, project_name: 'Other'})), /different or incomplete/);
});
test('name matching excludes investors, partial names and ambiguous projects', async () => {
  const results = await searchProjects('Sample', 'test', answer([
    {id: 1, type: 2, name: 'Sample'}, {id: 2, type: 1, name: ' Sample '}, {id: 3, type: 1, name: 'Sample Labs'}, {id: 0, type: 1, name: 'bad'},
  ]));
  assert.equal(uniqueExactProject('sample', results)?.id, 2);
  assert.equal(uniqueExactProject('Sam', results), null);
  assert.equal(uniqueExactProject('Sample', [...results, {...results[1]!, id: 4}]), null);
  assert.equal(safeLink('https://rootdata.com.evil.example/test', true), null);
  assert.equal(safeLink('https://user:password@example.com'), null);
});
