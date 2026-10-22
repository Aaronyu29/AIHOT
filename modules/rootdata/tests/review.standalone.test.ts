import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewHash, validateReview, type ReviewOutput} from '../review-content.ts';
import type {FundingAdminProject} from '../contracts.ts';

const project: FundingAdminProject = {id: 1, name: 'Sample', description: '', tags: [], logo: null, rootdataUrl: null,
  website: null, profileStatus: 'pending', trackingStatus: 'watching', profileUpdatedAt: null,
  lastNewsAt: '2026-10-22T10:00:00Z', reasons: [], reviewStatus: 'pending', version: 1, rootdataId: null, publicReason: '', lastError: null,
  evidence: [{articleId: 'article1', title: 'Sample raises $10 million to build a data network', summary: 'The product serves developers.',
    sourceName: 'News', url: 'https://example.org/article', publishedAt: '2026-10-22T10:00:00Z', kind: 'funding'}]};
const output: ReviewOutput = {decision: 'approve', reason: '跟踪开发者数据网络交付。', identityMatched: true, fundingConfirmed: true,
  canonicalName: null, nameCitation: null, citations: [{sourceId: 'article1', quote: project.evidence[0]!.title}]};

test('current financing evidence can approve without a RootData profile; unrelated claims cannot', () => {
  assert.equal(validateReview(output, project).decision, 'approve');
  for (const change of [{identityMatched: false}, {fundingConfirmed: false}]) assert.throws(() => validateReview({...output, ...change}, project), /Approval/);
  assert.throws(() => validateReview(output, {...project, evidence: project.evidence.map(e => ({...e, kind: 'update'}))}), /Approval/);
  assert.throws(() => validateReview(output, {...project, name: 'Other'}), /Approval/);
  for (const quote of ['      ', 'a     b', 'Sample raised a billion dollars']) {
    assert.throws(() => validateReview({...output, citations: [{sourceId: 'article1', quote}]}, project));
  }
  assert.throws(() => validateReview({...output, citations: [{sourceId: 'rootdata', quote: project.evidence[0]!.title}]}, project), /citation/);
});

test('real headline forms support exact canonical project names, not an invented name or a partial match', () => {
  const examples = [
    ['SoFi 联合创始人 Mike Cagney', 'Navra', 'SoFi 联合创始人 Mike Cagney 为 Navra 融资 1900 万美元'],
    ['Solana 生态稳定币协议 Hylo', 'Hylo', 'Solana 生态稳定币协议 Hylo 完成 100 万美元战略融资'],
    ['Umia 通过 $UMIA 代币拍卖', 'Umia', 'Umia 通过 $UMIA 代币拍卖完成 600 万美元融资'],
    ['红杉支持的 Catalyst', 'Catalyst', '红杉支持的 Catalyst 融资 3000 万美元，为普通投资者打造 AI 交易智能体'],
  ];
  for (const [name, canonicalName, title] of examples) {
    const value = {...project, name: name!, evidence: [{...project.evidence[0]!, title: title!}]};
    const citation = {sourceId: 'article1', quote: title!};
    const answer = {...output, canonicalName: canonicalName!, nameCitation: citation, citations: [citation]};
    assert.equal(validateReview(answer, value).canonicalName, canonicalName);
    assert.throws(() => validateReview({...answer, nameCitation: null}, value), /Canonical/);
    assert.throws(() => validateReview({...answer, canonicalName: canonicalName!.slice(0, -1)}, value), /Canonical/);
    assert.throws(() => validateReview({...answer, canonicalName: 'InventedName'}, value), /Canonical/);
  }
});

test('input identity follows facts and project identity, never its own output or admin state', () => {
  const before = reviewHash(project);
  const changed: FundingAdminProject = {...project, publicReason: 'Changed', reasons: ['Changed'], reviewStatus: 'approved',
    version: 3, trackingStatus: 'paused', lastError: 'old error', profileUpdatedAt: '2030-01-01',
    autoReview: {decision: 'approve', reason: 'old', reviewedAt: '2030-01-01', model: 'test'}};
  assert.equal(reviewHash(changed), before);
  assert.notEqual(reviewHash({...project, id: 2}), before, 'two candidates never share a request identity');
  assert.notEqual(reviewHash({...project, name: 'Other'}), before);
  assert.notEqual(reviewHash({...project, description: 'New product evidence'}), before);
  assert.notEqual(reviewHash({...project, evidence: [{...project.evidence[0]!, summary: 'Funding was denied.'}]}), before);
  assert.notEqual(reviewHash({...project, evidence: []}), before);
});
