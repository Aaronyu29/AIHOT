import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analysisHash, currentAnalysis, validateAnalysis} from '../analysis-content.ts';
import type {FundingProject} from '../contracts.ts';

const project: FundingProject = {id: 1, name: 'Sample', description: 'Sample provides a data network.', logo: null, tags: ['Data'], rootdataUrl: 'https://cn.rootdata.com/Projects/detail/Sample', website: null, profileStatus: 'linked', trackingStatus: 'watching', profileUpdatedAt: null, lastNewsAt: '2026-10-22T10:00:00Z', reasons: ['Follow product delivery'], evidence: [{articleId: 'article1', title: 'Sample raises $10 million', summary: 'The company will publish a product prototype.', url: 'https://example.com/report', sourceName: 'News', publishedAt: '2026-10-22T10:00:00Z', kind: 'funding'}]};
const assessment = {text: 'Product delivery remains to be verified.', kind: 'assessment' as const, citations: [{sourceId: 'article1', quote: 'The company will publish a product prototype.'}]};
const output = {confidence: 'high' as const, whatItDoes: {text: 'A data network', kind: 'fact' as const, citations: [{sourceId: 'rootdata', quote: 'Sample provides a data network.'}]}, chainAssessment: {text: '尚无足够资料确认部署链', kind: 'unknown' as const, citations: []}, promotionAssessment: assessment, outlook: assessment, opportunities: [assessment], risks: [assessment], watchSignals: ['Track whether the prototype launches.']};

test('analysis accepts traceable quotes, explicit unknown chain and conditional outlook', () => {
  const validated = validateAnalysis(output, project);
  assert.equal(validated.confidence, 'low', 'few sources cannot yield high confidence');
  assert.equal(validated.chainAssessment.kind, 'unknown');
});
test('analysis rejects invented sources, altered quotes and unsupported facts', () => {
  assert.throws(() => validateAnalysis({...output, whatItDoes: [output.whatItDoes]}, project), /expected object/);
  assert.throws(() => validateAnalysis({...output, whatItDoes: {...output.whatItDoes, citations: [{sourceId: 'invented', quote: 'Sample provides a data network.'}]}}, project), /citation/);
  assert.throws(() => validateAnalysis({...output, whatItDoes: {...output.whatItDoes, citations: [{sourceId: 'rootdata', quote: 'Sample runs on Ethereum.'}]}}, project), /citation/);
  assert.throws(() => validateAnalysis({...output, whatItDoes: {...output.whatItDoes, citations: []}}, project), /citation/);
  for (const quote of ['      ', '\n \n \n ', 'a     b']) assert.throws(() => validateAnalysis({...output, whatItDoes: {...output.whatItDoes, citations: [{sourceId: 'rootdata', quote}]}}, project));
  assert.throws(() => validateAnalysis({...output, outlook: {...assessment, kind: 'fact'}}, project), /judgement/);
  assert.throws(() => validateAnalysis({...output, chainAssessment: assessment}, project), /confirmed/);
});
test('corrections, withdrawals and identity changes hide a saved analysis immediately', () => {
  const saved = {inputs_hash: analysisHash(project), output, generated_at: new Date('2026-10-22T10:00:00Z'), model: 'deepseek-flash'};
  assert.ok(currentAnalysis(project, saved));
  assert.equal(currentAnalysis({...project, evidence: []}, saved), null);
  assert.equal(currentAnalysis({...project, name: 'Other'}, saved), null);
  assert.equal(currentAnalysis({...project, evidence: [{...project.evidence[0], summary: 'Financing has been denied.'}]}, saved), null);
  assert.equal(analysisHash({...project, profileUpdatedAt: '2026-10-23T10:00:00Z'}), analysisHash(project), 'unchanged profile refresh does not spend model budget');
});
