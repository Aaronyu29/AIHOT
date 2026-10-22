import { createHmac } from 'node:crypto';
export const NEWS_PATH = '/api/v6/dex/market/social/news/latest';
export interface Credentials { key: string; secret: string; passphrase: string }
export interface NewsArticle { id: string; title: string; summary: string; sourceUrl: string; source?: string; timestamp: string | number; tokenSymbols?: string[] }
export interface NewsPage { cursor: string | null; articles: NewsArticle[] }
export class NewsApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(`OKX news HTTP ${status}, code ${code}`); this.status=status; this.code=code; }
}
export function newsPath(begin: number, end: number, cursor?: string): string {
  const q = new URLSearchParams({begin: String(begin), end: String(end), limit: '50', detailLevel: '1', language: 'zh_CN'});
  if (cursor) q.set('cursor', cursor);
  return NEWS_PATH + '?' + q;
}
export async function fetchNews(path: string, credentials: Credentials, request: typeof fetch = fetch): Promise<NewsPage> {
  if (!path.startsWith(NEWS_PATH + '?')) throw new Error('Invalid news path');
  const timestamp = new Date().toISOString();
  const signature = createHmac('sha256', credentials.secret).update(timestamp + 'GET' + path).digest('base64');
  const response = await request('https://web3.okx.com' + path, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(25000), headers: {
    'OK-ACCESS-KEY': credentials.key, 'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase, 'OK-ACCESS-TIMESTAMP': timestamp,
  }});
  if (!response.ok) throw new NewsApiError(response.status, 'http_error');
  const payload = await response.json() as {code?: string; data?: NewsPage};
  if (String(payload.code) !== '0') throw new NewsApiError(response.status, /^\d+$/.test(String(payload.code)) ? String(payload.code) : 'provider_error');
  if (!payload.data || !Array.isArray(payload.data.articles) || !(payload.data.cursor === null || typeof payload.data.cursor === 'string')) throw new Error('Invalid OKX news response');
  return payload.data;
}
const CRYPTO = /\b(?:bitcoin|ethereum|solana|blockchain|crypto|defi|web3|stablecoin|btc|eth|sol|usdt|usdc|xrp|bnb|doge|nft|airdrop|tokenization)\b|比特币|以太坊|区块链|加密(?:货币|资产|市场|行业)|稳定币|链上|代币|永续合约|空投|币安|欧易|交易所|钱包|公链|质押|矿工|挖矿/i;
export function newsItem(article: NewsArticle, now = Date.now()) {
  if (!article || typeof article.title !== 'string' || typeof article.summary !== 'string' || typeof article.sourceUrl !== 'string') return null;
  const publishedAt = new Date(Number(article.timestamp));
  if (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() > now + 300000) return null;
  let url: URL; try { url = new URL(article.sourceUrl); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const title = article.title.replace(/\s+/g, ' ').trim().slice(0, 1000);
  const excerpt = article.summary.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!title || !excerpt || !((Array.isArray(article.tokenSymbols) && article.tokenSymbols.length > 0) || CRYPTO.test(title + ' ' + excerpt))) return null;
  return {url: url.href, title, excerpt, publishedAt, bodyStatus: 'none' as const,
    raw: {okxNewsId: article.id, platform: article.source ?? '', tokenSymbols: article.tokenSymbols ?? []}};
}

export interface Project extends Credentials { id: string }
export function parseProjects(raw: string): Project[] {
  let projects: unknown; try { projects = JSON.parse(raw); } catch { throw new Error('Invalid OKX news credential pool'); }
  if (!Array.isArray(projects) || !projects.length || projects.some(p => !p || !/^[A-Za-z0-9_-]{1,40}$/.test(p.id) || ['key','secret','passphrase'].some(k => typeof p[k] !== 'string' || !p[k].trim()))) throw new Error('Invalid OKX news credential pool');
  if (new Set(projects.map(p=>p.id)).size !== projects.length || new Set(projects.map(p=>p.key)).size !== projects.length) throw new Error('Duplicate OKX news project credentials');
  return projects as Project[];
}
export function selectProject(projects: Project[], position: number) {
  if (!projects.length) throw new Error('Missing OKX news credentials');
  const index = Number.isSafeInteger(position) && position >= 0 ? position % projects.length : 0;
  return {project: projects[index], next: (index + 1) % projects.length};
}
