// Read-only deployment check. Visits saved public results; never calls RootData.
import assert from 'node:assert/strict';
import type { FundingProjectList } from '../contracts.ts';
const base = process.argv[2] ?? 'http://127.0.0.1:3000';
async function get(path: string) {
  const response = await fetch(new URL(path, base), {signal: AbortSignal.timeout(30000), redirect: 'manual'});
  assert.equal(response.status, 200, path);
  return response;
}
const html = await (await get('/funding')).text();
assert.ok(html.includes('融资'), 'funding page title');
const list = await (await get('/api/site/funding-projects')).json() as FundingProjectList;
assert.ok(Array.isArray(list.items));
assert.ok(typeof list.total === 'number');
assert.ok(typeof list.notice === 'string');
assert.ok(!/"(?:apikey|api_key|ROOTDATA_API_KEY)"\s*:/.test(JSON.stringify(list)), 'no public credential fields');
for (const project of list.items.slice(0, 10)) {
  assert.ok(Number.isSafeInteger(project.id) && project.id > 0);
  assert.ok(project.evidence.some(e => e.kind === 'funding'), 'public project has current funding evidence');
  await get(`/api/site/funding-projects/${project.id}`);
  const detail = await (await get(`/funding/${project.id}`)).text();
  assert.ok(detail.includes('RootData'), 'detail attributes RootData');
}
const admin = await fetch(new URL('/api/admin/funding-projects', base), {redirect: 'manual'});
assert.equal(admin.status, 401, 'admin requires authentication');
console.log(JSON.stringify({ok: true, publicProjects: list.total, detailPagesChecked: Math.min(list.items.length, 10), adminProtected: true}));
