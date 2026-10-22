import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { credential } from "@aihot/backend/config";
import { logTaskError } from "@aihot/backend/lib/log-error";
import { sha256 } from "@aihot/backend/lib/ids";
import { readPublishedEvidence } from "@aihot/backend/publication/module-evidence";
import { BudgetExceededError, completeReceipt, paidRequest, ProviderRejectedError, failureKind, failedReceiptId, type ReceiptResult } from "@aihot/backend/providers/receipts";
import { getProject, getQuota, RootDataError, searchProjects, uniqueExactProject, type RootDataProject, type RootDataQuota, type RootDataSearchResult } from "./client.ts";
import { projectViews, type ProjectRow } from "./publication.ts";
import { fundingCandidateName, mentionsProject, normalizedProjectName } from "./rules.ts";
import type { FundingAdminList, FundingStatus } from "./contracts.ts";

const DAY = 86_400_000;
const REFRESH = 7 * DAY;
const positiveLimit = (value: string | undefined, fallback: number) => value === undefined ? fallback
  : /^\d+$/.test(value) ? Math.min(1000, Number(value)) : 0;

export function rootdataConfiguration() {
  return { enabled: process.env.ROOTDATA_ENABLED === "true" && process.env.COLLECT_ENABLED === "true", apiKey: credential("collectors", "ROOTDATA_API_KEY")?.trim() ?? "",
    monthlyCredits: positiveLimit(process.env.ROOTDATA_MONTHLY_CREDITS, 800), dailyCredits: positiveLimit(process.env.ROOTDATA_DAILY_CREDITS, 24) };
}

interface QuotaSnapshot extends RootDataQuota { checkedAt: string; account: string }

async function quotaSnapshot(db: Db = sql): Promise<QuotaSnapshot | null> {
  const [row] = await db<{ value: QuotaSnapshot }[]>`SELECT value FROM settings WHERE key = 'rootdata.quota'`;
  return row?.value ?? null;
}

export async function fundingStatus(): Promise<FundingStatus> {
  const config = rootdataConfiguration();
  const quota = await quotaSnapshot();
  return { enabled: config.enabled, configured: Boolean(config.apiKey), quota: quota
    ? { credits: quota.credits, totalCredits: quota.totalCredits, checkedAt: quota.checkedAt } : null };
}

/** Called within paidRequest's service lock; reservations survive failed/unknown calls. */
export async function reserveRootDataCredits(db: Db, credits: number, account: string): Promise<void> {
  const [counts] = await db<{ n: number }[]>`SELECT count(*) AS n FROM receipt_attempts WHERE service = 'rootdata' AND origin = 'live' AND started_at > now() - interval '1 minute'`;
  if ((counts?.n ?? 0) >= 50) throw new BudgetExceededError("rootdata", "minute", 60);
  if (credits === 0) return;
  const config = rootdataConfiguration();
  const quota = await quotaSnapshot(db);
  if (!quota || quota.account !== account || Date.now() - Date.parse(quota.checkedAt) > 2 * 60 * 60_000) {
    throw new BudgetExceededError("rootdata", "quota_unknown", 3600);
  }
  const [used] = await db<{ month: number; day: number; since_quota: number }[]>`
    SELECT coalesce(sum(credits), 0) AS month,
      coalesce(sum(credits) FILTER (WHERE created_at > now() - interval '1 day'), 0) AS day,
      coalesce(sum(credits) FILTER (WHERE created_at >= ${new Date(quota.checkedAt)}), 0) AS since_quota
    FROM rootdata_credit_reservations WHERE created_at > now() - interval '31 days'`;
  if ((used?.month ?? 0) + credits > config.monthlyCredits) throw new BudgetExceededError("rootdata", "31_days", 86400);
  if ((used?.day ?? 0) + credits > config.dailyCredits) throw new BudgetExceededError("rootdata", "day", 3600);
  if (quota.credits - (used?.since_quota ?? 0) - credits < 100) throw new BudgetExceededError("rootdata", "reserve", 86400);
  await db`INSERT INTO rootdata_credit_reservations (credits) VALUES (${credits})`;
}

export interface RootDataProvider {
  quota: (key: string) => Promise<RootDataQuota>;
  search: (query: string, key: string) => Promise<RootDataSearchResult[]>;
  project: (id: number, key: string) => Promise<RootDataProject>;
}
const provider: RootDataProvider = { quota: getQuota, search: searchProjects, project: getProject };

async function recordedCall<T>(endpoint: string, identity: object, account: string, credits: number, call: () => Promise<T>): Promise<ReceiptResult & { response: T }> {
  return await paidRequest({ service: "rootdata", purpose: `rootdata.${endpoint}`, identity: { account, ...identity }, requestSummary: { endpoint, credits } },
    async () => {
      try { return { response: await call(), usage: { credits } }; }
      catch (error) {
        if (error instanceof RootDataError && error.status !== null &&
          (error.status < 200 || error.status >= 300 || (error.code !== null && error.code !== 200))) {
          throw Object.assign(new ProviderRejectedError(error.message, error.status, error.retryable, [401, 403].includes(error.status) || [401, 403].includes(error.code ?? 0)),
            { code: error.code === null ? undefined : String(error.code) });
        }
        throw error;
      }
    },
    (db) => reserveRootDataCredits(db, credits, account)) as ReceiptResult & { response: T };
}

/** Only reads already-public summaries; discovering candidates works without an API key. */
export async function discoverFundingCandidates(now = new Date()): Promise<{ scanned: number; candidates: number; truncated: boolean }> {
  let scanned = 0;
  let candidates = 0;
  const watched = await sql<{ id: number; name: string }[]>`SELECT id, name FROM rootdata_projects WHERE review_status = 'approved' AND tracking_status = 'watching'`;
  for (let page = 0; page < 20; page += 1) {
    const reports = await readPublishedEvidence({ since: new Date(now.getTime() - 30 * DAY), limit: 500, offset: page * 500 });
    scanned += reports.length;
    for (const report of reports) {
      const name = fundingCandidateName(report.title) ?? fundingCandidateName(report.originalTitle);
      const targets = new Map<number, "funding" | "update">();
      if (name) {
        // A reviewed name correction belongs to this unchanged report; rediscovery must not
        // recreate the old spelling as a second candidate on every scheduled run.
        const [existing] = await sql<{ id: number }[]>`SELECT project_id AS id FROM rootdata_evidence
          WHERE article_id = ${report.articleId} AND publication_revision = ${report.revision} AND kind = 'funding' LIMIT 1`;
        const row = existing ?? (await sql<{ id: number }[]>`INSERT INTO rootdata_projects (name, name_key)
          VALUES (${name}, ${normalizedProjectName(name)}) ON CONFLICT (name_key) DO UPDATE SET name_key = EXCLUDED.name_key RETURNING id`)[0]!;
        targets.set(row!.id, "funding");
        candidates += 1;
      }
      for (const project of watched) {
        if (mentionsProject(report.title, project.name) || mentionsProject(report.originalTitle, project.name)) {
          targets.set(project.id, name && normalizedProjectName(name) === normalizedProjectName(project.name) ? "funding" : targets.get(project.id) ?? "update");
        }
      }
      for (const [projectId, kind] of targets) {
        await sql`INSERT INTO rootdata_evidence (project_id, article_id, kind, publication_revision)
          VALUES (${projectId}, ${report.articleId}, ${kind}, ${report.revision})
          ON CONFLICT (project_id, article_id) DO UPDATE SET kind = EXCLUDED.kind, publication_revision = EXCLUDED.publication_revision`;
      }
    }
    if (reports.length < 500) return { scanned, candidates, truncated: false };
  }
  return { scanned, candidates, truncated: true };
}

/** All provider calls run in the worker, never in a reader/admin request. */
export async function enrichFundingProjects(remote: RootDataProvider = provider): Promise<{ refreshed: number; skipped: string | null }> {
  const config = rootdataConfiguration();
  if (!config.enabled || !config.apiKey) return { refreshed: 0, skipped: "disabled_or_missing_key" };
  const account = sha256(config.apiKey).slice(0, 20);
  const quotaResult = await recordedCall("quotacredits", { hour: Math.floor(Date.now() / 3_600_000) }, account, 0,
    async () => ({ ...await remote.quota(config.apiKey), checkedAt: new Date().toISOString(), account }));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO settings (key, value, updated_by) VALUES ('rootdata.quota', ${tx.json(quotaResult.response)}, 'rootdata')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    await completeReceipt(tx, quotaResult.receiptId);
  });
  const due = await sql<ProjectRow[]>`SELECT * FROM rootdata_projects WHERE review_status <> 'rejected'
    AND tracking_status = 'watching' AND next_refresh_at <= now()
    ORDER BY CASE WHEN review_status = 'approved' THEN 0 ELSE 1 END, next_refresh_at, id LIMIT 12`;
  let refreshed = 0;
  for (const row of due) {
    // Do not spend credits on candidates whose source was withdrawn or corrected.
    if (!(await projectViews([row]))[0]?.evidence.some((e) => e.kind === "funding")) {
      await sql`UPDATE rootdata_projects SET next_refresh_at = ${new Date(Date.now() + DAY)}, updated_at = now()
        WHERE id = ${row.id} AND version = ${row.version}`;
      continue;
    }
    const identity = { project: row.id, version: row.version, due: row.next_refresh_at.toISOString() };
    let rootdataId = row.rootdata_id;
    try {
      if (rootdataId === null) {
        const result = await recordedCall("ser_inv", { ...identity, name: row.name_key }, account, 0, () => remote.search(row.name, config.apiKey));
        const match = uniqueExactProject(row.name, result.response);
        await sql.begin(async (tx) => {
          await completeReceipt(tx, result.receiptId);
          if (!match) await tx`UPDATE rootdata_projects SET next_refresh_at = ${new Date(Date.now() + REFRESH)},
            last_error = '没有唯一同名项目，请核对项目名称或指定 RootData ID', updated_at = now() WHERE id = ${row.id} AND version = ${row.version}`;
        });
        if (!match) continue;
        rootdataId = match.id;
      }
      const result = await recordedCall("get_item", { ...identity, rootdataId }, account, 2, () => remote.project(rootdataId!, config.apiKey));
      if (result.response.projectId !== rootdataId) throw new Error("RootData returned a different project ID");
      const updated = await sql.begin(async (tx) => {
        // An administrator may have changed the identity while the provider request was in flight.
        const changed = await tx`UPDATE rootdata_projects SET rootdata_id = ${rootdataId}, profile = ${tx.json(result.response as never)},
          profile_updated_at = now(), next_refresh_at = ${new Date(Date.now() + REFRESH)}, last_error = NULL, updated_at = now()
          WHERE id = ${row.id} AND version = ${row.version} RETURNING id`;
        await completeReceipt(tx, result.receiptId);
        return changed.length > 0;
      });
      if (updated) refreshed += 1;
    } catch (error) {
      logTaskError(error, { msg: "funding refresh failed", job: "rootdata.sync", projectId: row.id,
        kind: failureKind(error), receiptId: failedReceiptId(error), level: error instanceof BudgetExceededError ? "warn" : "error" });
      const message = error instanceof BudgetExceededError ? error.message : "RootData 同步未完成，请检查运行回执后重试";
      await sql`UPDATE rootdata_projects SET last_error = ${message}, updated_at = now() WHERE id = ${row.id} AND version = ${row.version}`;
      if (error instanceof BudgetExceededError) return { refreshed, skipped: message };
      // Stop this run on provider failure; the durable receipt governs any later retry.
      throw error;
    }
  }
  return { refreshed, skipped: null };
}

export async function syncFundingProjects() {
  // Multiple worker processes can receive a schedule; a session lock covers the network phase too.
  const connection = await sql.reserve();
  const lock = "rootdata.sync";
  let locked = false;
  try {
    const [held] = await connection<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${lock})) AS locked`;
    locked = held?.locked ?? false;
    if (!locked) return { skipped: "already_running" };
    const discovery = await discoverFundingCandidates();
    const enrichment = await enrichFundingProjects();
    return { ...discovery, ...enrichment };
  } finally {
    try {
      if (locked) await connection`SELECT pg_advisory_unlock(hashtext(${lock}))`;
    } finally {
      connection.release();
    }
  }
}

export async function listFundingAdmin(): Promise<FundingAdminList> {
  const rows = await sql<ProjectRow[]>`SELECT * FROM rootdata_projects ORDER BY CASE WHEN review_status = 'pending' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 500`;
  return { items: await projectViews(rows), status: await fundingStatus() };
}

const Patch = z.object({ version: z.number().int().positive(), reason: z.string().trim().min(1).max(500),
  name: z.string().trim().min(2).max(80).optional(), reviewStatus: z.enum(["pending", "approved", "rejected"]).optional(),
  trackingStatus: z.enum(["watching", "paused"]).optional(), rootdataId: z.number().int().positive().nullable().optional(),
  publicReason: z.string().trim().max(500).optional() }).strict();

export async function updateFundingProject(id: number, input: unknown, actor: string) {
  const patch = Patch.parse(input);
  return sql.begin(async (tx) => {
    const [before] = await tx<ProjectRow[]>`SELECT * FROM rootdata_projects WHERE id = ${id} FOR UPDATE`;
    if (!before) return null;
    if (before.version !== patch.version) throw new Conflict("项目已更新，请刷新后再审核");
    const review = patch.reviewStatus ?? before.review_status;
    const reason = patch.publicReason ?? before.public_reason;
    if (review === "approved") {
      if (!reason) throw Object.assign(new Error("批准前请填写公开跟踪理由"), { statusCode: 400 });
      if (!(await projectViews([before], tx))[0]?.evidence.some((e) => e.kind === "funding")) {
        throw Object.assign(new Error("缺少仍公开有效的融资报道，请先核对新闻证据"), { statusCode: 400 });
      }
    }
    const renamed = patch.name !== undefined && patch.name !== before.name;
    const relinked = patch.rootdataId !== undefined && patch.rootdataId !== before.rootdata_id;
    const identityChanged = renamed || relinked;
    const rootdataId = patch.rootdataId !== undefined ? patch.rootdataId : renamed ? null : before.rootdata_id;
    try {
      const [after] = await tx<ProjectRow[]>`UPDATE rootdata_projects SET name = ${patch.name ?? before.name},
        name_key = ${normalizedProjectName(patch.name ?? before.name)}, rootdata_id = ${rootdataId},
        review_status = ${review}, tracking_status = ${patch.trackingStatus ?? before.tracking_status}, public_reason = ${reason},
        profile = ${identityChanged ? null : before.profile ? tx.json(before.profile as never) : null},
        profile_updated_at = ${identityChanged ? null : before.profile_updated_at},
        next_refresh_at = ${identityChanged ? new Date() : before.next_refresh_at},
        last_error = ${identityChanged ? null : before.last_error}, version = version + 1, updated_at = now()
        WHERE id = ${id} RETURNING *`;
      await audit(actor, "rootdata.review", `rootdata:${id}`, patch.reason, before, after, { db: tx });
      return (await projectViews([after!], tx))[0]!;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new Conflict("项目名称或 RootData ID 已关联其他项目，请先核对重复候选");
      throw error;
    }
  });
}
