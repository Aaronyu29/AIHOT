import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHmac} from 'node:crypto';
import {fetchNews, newsItem, newsPath, NewsApiError, parseProjects, selectProject} from '../client.ts';
const keys={key:'local-test-key',secret:'local-test-secret',passphrase:'local-test-passphrase'};
const item={id:'news-1',title:'比特币 ETF 最新进展',summary:'机构公布比特币 ETF 申购数据。',sourceUrl:'https://example.org/news/1',timestamp:Date.UTC(2026,9,20),tokenSymbols:['BTC']};
test('signed summary request preserves cursor and never enables payments',async()=>{
 const path=newsPath(1000,2000,'a+b/==');
 assert.equal(new URL('https://example.org'+path).searchParams.get('cursor'),'a+b/==');
 const result=await fetchNews(path,keys,async(url,init)=>{
  assert.equal(new URL(String(url)).hostname,'web3.okx.com');
  const h=init!.headers as Record<string,string>;
  assert.equal(h['OK-ACCESS-SIGN'],createHmac('sha256',keys.secret).update(h['OK-ACCESS-TIMESTAMP']+'GET'+path).digest('base64'));
  assert.equal(h['OK-ACCESS-KEY'],keys.key);
  assert.equal(h['OK-ACCESS-PASSPHRASE'],keys.passphrase);
  assert.equal(init!.redirect,'error');
  assert.equal(Object.keys(h).length,4);
  assert.equal(new URL(String(url)).searchParams.get('detailLevel'),'1');
  return Response.json({code:'0',data:{cursor:null,articles:[item]}});
 });
 assert.equal(result.articles.length,1);
});
test('API refusal stops without retry, payment or leaking provider text',async()=>{
 let calls=0;
 await assert.rejects(fetchNews(newsPath(1000,2000),keys,async()=>{calls++;return Response.json({msg:keys.secret},{status:402});}),e=>e instanceof NewsApiError && e.status===402 && !e.message.includes(keys.secret));
 assert.equal(calls,1);
 await assert.rejects(fetchNews(newsPath(1000,2000),keys,async()=>Response.json({code:'50105',msg:keys.secret})),/code 50105/);
});
test('malformed responses do not become successful empty pages',async()=>{
 await assert.rejects(fetchNews(newsPath(1000,2000),keys,async()=>Response.json({code:'0',data:{cursor:null}})),/Invalid OKX news response/);
});
test('news is summary-only with original link and exact publication date',()=>{
 const result=newsItem(item,Date.UTC(2026,9,22))!;
 assert.equal(result.bodyStatus,'none');assert.equal(result.excerpt,item.summary);assert.equal(result.url,item.sourceUrl);
 assert.equal(result.publishedAt.toISOString(),'2026-10-20T00:00:00.000Z');assert.equal('bodyText' in result,false);
});
test('unrelated AI news, malformed dates and unsafe links are rejected',()=>{
 const now=Date.UTC(2026,9,22);
 assert.equal(newsItem({...item,title:'OpenAI 发布新模型',summary:'人工智能研究新进展',tokenSymbols:[]},now),null);
 assert.equal(newsItem({...item,sourceUrl:'javascript:alert(1)'},now),null);
 assert.equal(newsItem({...item,sourceUrl:'https://user:password@example.org/a'},now),null);
 assert.equal(newsItem({...item,timestamp:'bad'},now),null);
 assert.equal(newsItem({...item,timestamp:now+3600000},now),null);
 assert.equal(newsItem({...item,summary:''},now),null);
 assert.ok(newsItem({...item,title:'稳定币监管规则公布',tokenSymbols:[]},now));
});

test('credentials rotate across calls and survive a restored position',()=>{
 const pool=parseProjects(JSON.stringify([{...keys,id:'A'},{key:'other',secret:'other-secret',passphrase:'other-pass',id:'B'}]));
 const first=selectProject(pool,0),second=selectProject(pool,first.next);
 assert.equal(first.project.id,'A');assert.equal(second.project.id,'B');assert.equal(selectProject(pool,second.next).project.id,'A');
 assert.equal(selectProject(pool,JSON.parse(JSON.stringify({keyIndex:first.next})).keyIndex).project.id,'B');
 assert.throws(()=>parseProjects(JSON.stringify([{...keys,id:'A'},{...keys,id:'B'}])),/Duplicate/);
 assert.throws(()=>parseProjects('broken'),/Invalid/);
});
