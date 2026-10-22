import { credential } from '@aihot/backend/config';
import { sql } from '@aihot/backend/db';
import { logTaskError } from '@aihot/backend/lib/log-error';
import { defineServerModule } from '@aihot/backend/modules';
import { identityKeyFor, upsertMaterial } from '@aihot/backend/content/materials';
import { queueProcessing } from '@aihot/backend/jobs/content';
import { BudgetExceededError, ProviderRejectedError, paidRequest, completeReceipt } from '@aihot/backend/providers/receipts';
import { fetchNews, newsItem, newsPath, NewsApiError, parseProjects, selectProject, type NewsPage } from './client.ts';
export const SOURCE_ID = 'okx-news';
function credentials() {
  const raw = credential('collectors', 'OKX_NEWS_PROJECTS_JSON');
  return raw ? parseProjects(raw) : null;
}
export async function collectNews(force = false, read: typeof fetchNews = fetchNews) {
  if (process.env.COLLECT_ENABLED !== 'true') return {status: 'disabled'};
  const projects = credentials();
  if (!projects) return {status: 'disabled'};
  return sql.begin(async tx => {
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext('okx-news.collect')) AS held`;
    if (!lock.held) return {status: 'busy'};
    const [source] = await tx`SELECT * FROM sources WHERE id=${SOURCE_ID} FOR UPDATE`;
    if (!source?.enabled || (!force && source.next_fetch_at && new Date(source.next_fetch_at).getTime() > Date.now())) return {status: 'skipped'};
    const [budget] = await tx`SELECT service FROM budgets WHERE service='okx_news'`;
    if (!budget) throw new Error('Configure okx_news request budget before collecting');
    const [run] = await tx`INSERT INTO fetch_runs(source_id) VALUES (${SOURCE_ID}) RETURNING id`;
    const previous = source.cursor ?? {};
    const initial = !previous.initializedAt;
    const end = previous.inProgress ? Number(previous.end) : Math.floor(Date.now() / 900000) * 900000;
    const begin = previous.inProgress ? Number(previous.begin) : initial ? end - 72 * 3600000 : Math.max(end - 72 * 3600000, Number(previous.coveredTo) - 2 * 3600000);
    let cursor: string | undefined = previous.pageCursor;
    let keyIndex = Number(previous.keyIndex ?? 0);
    let found = 0, created = 0, duplicates = 0, filtered = 0, pages = 0;
    const receipts: number[] = [];
    try {
      for (; pages < 2; ) {
        const path = newsPath(begin, end, cursor);
        const selected = selectProject(projects, keyIndex);
        keyIndex = selected.next;
        const project = selected.project;
        const receipt = await paidRequest({service: 'okx_news', model: project.id, purpose: 'news_latest', subject: `source:${SOURCE_ID}`, identity: {path, project: project.id}, requestSummary: {path, project: project.id}}, async () => {
          try { return {response: await read(path, project)}; }
          catch (error) {
            if (error instanceof NewsApiError) throw Object.assign(new ProviderRejectedError(error.message, error.status, error.status >= 500 || error.status === 429), { code: error.code.toUpperCase() });
            throw error;
          }
        });
        receipts.push(receipt.receiptId);
        const page = receipt.response as NewsPage;
        pages++; found += page.articles.length;
        for (const article of page.articles) {
          const item = newsItem(article);
          if (!item) { filtered++; continue; }
          if (initial && created >= 8) continue;
          const identity = identityKeyFor({...item, sourceId: SOURCE_ID, via: 'fetch'});
          const [existing] = await tx`SELECT id FROM articles WHERE identity_key=${identity}`;
          if (existing) { duplicates++; continue; }
          const result = await upsertMaterial({...item, sourceId: SOURCE_ID, language: 'zh', via: 'fetch', backfill: initial ? 'okx-news-initial' : null}, tx);
          if (result.created) created++;
          if (result.created || result.revised || result.processingNeeded) await queueProcessing(result.articleId, {db: tx});
        }
        if (page.cursor && page.cursor === cursor) throw new Error('OKX news pagination did not advance');
        cursor = page.cursor || undefined;
        if (!cursor || initial) break;
      }
      const next = {keyIndex, initializedAt: previous.initializedAt ?? new Date().toISOString(), coveredTo: !initial && cursor ? previous.coveredTo : end,
        ...(!initial && cursor ? {begin, end, pageCursor: cursor, inProgress: true} : {})};
      await tx`UPDATE sources SET cursor=${tx.json(next)},health='ok',fail_count=0,last_error=NULL,last_fetch_at=now(),last_ok_at=now(),updated_at=now(),next_fetch_at=now()+make_interval(mins=>interval_minutes) WHERE id=${SOURCE_ID}`;
      await tx`UPDATE fetch_runs SET status='ok',finished_at=now(),found_count=${found},new_count=${created},detail=${tx.json({pages,duplicates,filtered,summaryOnly:true,backlog:!!(!initial && cursor)})} WHERE id=${run.id}`;
      for (const id of receipts) await completeReceipt(tx, id);
      return {status:'ok',found,created,duplicates,filtered,pages};
    } catch (error) {
      const budget = error instanceof BudgetExceededError;
      logTaskError(error, { msg: 'news collection failed', job: 'okx-news.collect', sourceId: SOURCE_ID,
        runId: run.id, stage: 'collect', level: budget ? 'warn' : 'error' });
      const message = error instanceof NewsApiError || error instanceof ProviderRejectedError || budget ? error.message : 'OKX news collection failed; inspect the request receipt';
      await tx`UPDATE fetch_runs SET status='failed',finished_at=now(),error=${message} WHERE id=${run.id}`;
      await tx`UPDATE sources SET cursor=${tx.json({...previous,keyIndex,begin,end,pageCursor:cursor??null,inProgress:true})},last_fetch_at=now(),last_error=${message},fail_count=fail_count+${budget ? 0 : 1},health=CASE WHEN ${budget} THEN health ELSE 'degraded' END,next_fetch_at=now()+interval '15 minutes',updated_at=now() WHERE id=${SOURCE_ID}`;
      return {status:'failed',error:message};
    }
  });
}
export default defineServerModule({name:'okx-news',sourceKinds:{external:{fetchNow:async source=>source.id===SOURCE_ID?collectNews(true):{status:'skipped'}}},schedules:[{name:'okx-news.collect',cron:'* * * * *',when:()=>process.env.COLLECT_ENABLED==='true' && !!credential('collectors','OKX_NEWS_PROJECTS_JSON'),run:()=>collectNews()}]});
