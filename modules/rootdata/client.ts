// Basic-plan API boundary. Financing rounds, investors and change feeds are intentionally absent.
// Quota responses echo the credential: only the allowlisted fields below may reach receipts/storage.
export interface RootDataSearchResult {
  id: number;
  type: 1 | 2 | 3;
  name: string;
  logo: string | null;
  introduce: string | null;
  active: boolean | null;
  rootdataurl: string | null;
}
export interface RootDataProject {
  projectId: number;
  name: string;
  logo: string | null;
  oneLiner: string | null;
  description: string | null;
  tags: string[];
  active: boolean | null;
  rootdataUrl: string | null;
  website: string | null;
  twitter: string | null;
}
export interface RootDataQuota {
  level: string;
  credits: number;
  totalCredits: number;
  periodStart: number | null;
  periodEnd: number | null;
}
export class RootDataError extends Error {
  readonly status: number | null;
  readonly code: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null = null, code: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = status === null || status === 429 || status >= 500 || code === 429;
  }
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown, length = 2000): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, length) : null;
const boolean = (value: unknown) => typeof value === 'boolean' ? value : null;
function integer(value: unknown): number | null {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
export function safeLink(value: unknown, rootdataOnly = false): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (rootdataOnly && !(url.hostname === 'rootdata.com' || url.hostname.endsWith('.rootdata.com'))) return null;
    return url.href;
  } catch { return null; }
}

async function request(endpoint: 'ser_inv' | 'get_item' | 'quotacredits', body: ObjectValue, key: string, read: typeof fetch): Promise<unknown> {
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw new RootDataError('RootData API key is not configured');
  let response: Response;
  try {
    response = await read(`https://api.rootdata.com/open/${endpoint}`, {
      method: 'POST', headers: {apikey: key, language: 'cn', 'content-type': 'application/json'},
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new RootDataError('RootData request did not complete; inspect its receipt before retrying'); }
  if (!response.ok) throw new RootDataError(`RootData HTTP ${response.status}`, response.status);
  let envelope: ObjectValue;
  try { envelope = object(await response.json()); }
  catch { throw new RootDataError('RootData returned invalid JSON', response.status); }
  const code = integer(envelope.result);
  if (code !== 200) throw new RootDataError(`RootData business result ${code ?? 'invalid'}`, response.status, code);
  return envelope.data;
}

export async function searchProjects(query: string, apikey: string, read: typeof fetch = fetch): Promise<RootDataSearchResult[]> {
  if (!query.trim() || query.length > 200) throw new RootDataError('Invalid RootData search query');
  const result = await request('ser_inv', {query: query.trim()}, apikey, read);
  if (!Array.isArray(result)) throw new RootDataError('RootData returned an invalid search result', 200, 200);
  return result.flatMap(value => {
    const row = object(value), id = integer(row.id), name = text(row.name, 200), type = integer(row.type);
    if (!id || !name || (type !== 1 && type !== 2 && type !== 3)) return [];
    return [{id, name, type, logo: safeLink(row.logo), introduce: text(row.introduce), active: boolean(row.active), rootdataurl: safeLink(row.rootdataurl, true)}];
  });
}

export async function getProject(projectId: number, apikey: string, read: typeof fetch = fetch): Promise<RootDataProject> {
  if (!Number.isSafeInteger(projectId) || projectId < 1) throw new RootDataError('Invalid RootData project ID');
  const row = object(await request('get_item', {project_id: projectId, include_team: false, include_investors: false}, apikey, read));
  const id = integer(row.project_id), name = text(row.project_name, 200);
  if (id !== projectId || !name) throw new RootDataError('RootData returned a different or incomplete project', 200, 200);
  // The documentation describes an array but its example uses an object. Accept both documented shapes.
  const social = Array.isArray(row.social_media) ? row.social_media.map(object) : [object(row.social_media)];
  const socialLink = (field: string) => social.map(value => safeLink(value[field])).find(Boolean) ?? null;
  return {
    projectId, name, logo: safeLink(row.logo), oneLiner: text(row.one_liner), description: text(row.description, 10000),
    tags: Array.isArray(row.tags) ? [...new Set(row.tags.flatMap(tag => text(tag, 80) ?? []))].slice(0, 50) : [],
    active: boolean(row.active), rootdataUrl: safeLink(row.rootdataurl, true), website: socialLink('website'), twitter: socialLink('twitter'),
  };
}

export async function getQuota(apikey: string, read: typeof fetch = fetch): Promise<RootDataQuota> {
  const row = object(await request('quotacredits', {}, apikey, read));
  const credits = integer(row.credits), total = integer(row.total_credits), level = text(row.level, 30);
  if (credits === null || total === null || !level) throw new RootDataError('RootData returned an invalid quota', 200, 200);
  return {level: level.toLowerCase(), credits, totalCredits: total, periodStart: integer(row.start), periodEnd: integer(row.end)};
}

export function uniqueExactProject(query: string, results: RootDataSearchResult[]): RootDataSearchResult | null {
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const matches = results.filter(row => row.type === 1 && normalize(row.name) === normalize(query));
  const ids = new Set(matches.map(row => row.id));
  return ids.size === 1 ? matches[0]! : null;
}
