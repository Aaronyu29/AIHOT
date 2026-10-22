import { useState, type FormEvent } from "react";
import { Link, useLoaderData } from "react-router";
import { SITE } from "@aihot/site";
import type { FundingAdminList, FundingAdminProject, FundingProjectPatch } from "../contracts";
import type { LoaderArgs, MetaFunction } from "../../../apps/web/app/lib/route-types";
import { adminGet } from "../../../apps/web/app/lib/admin.server";
import { fullDateTime } from "../../../apps/web/app/lib/format";
import { useAdminAction } from "../../../apps/web/app/features/admin/action";
import { AdminPage, Badge, Button, Card, Empty, Input, Select, Stat, Textarea, Time } from "../../../apps/web/app/features/admin/ui";
import { ExternalLink } from "./components";

export async function loader({ request }: LoaderArgs) {
  return adminGet<FundingAdminList>(request, "/api/admin/funding-projects");
}

export const meta: MetaFunction = () => [{ title: `融资项目 · ${SITE.name} 后台` }];

const REVIEW_LABELS = { pending: "候选项目", approved: "已入选", rejected: "已排除" } as const;
const AUTO_REVIEW_LABELS = { approve: "值得跟踪", defer: "等待更多资料", reject: "暂不跟踪" } as const;

function ReviewProject({ project }: { project: FundingAdminProject }) {
  const { run, busy } = useAdminAction();
  const [name, setName] = useState(project.name);
  const [rootdataId, setRootdataId] = useState(project.rootdataId?.toString() ?? "");
  const [reviewStatus, setReviewStatus] = useState(project.reviewStatus);
  const [trackingStatus, setTrackingStatus] = useState(project.trackingStatus);
  const [publicReason, setPublicReason] = useState(project.publicReason);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const funding = project.evidence.filter((evidence) => evidence.kind === "funding");
  const autoReview = project.autoReview;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const id = rootdataId.trim() ? Number(rootdataId.trim()) : null;
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return setError("RootData 项目 ID 需要填写正整数。");
    if (!name.trim() || !reason.trim()) return setError("请填写项目名称和本次操作说明。");
    if (reviewStatus === "approved" && !funding.length) return setError("缺少有效公开融资报道，暂不能公开。");
    const body: FundingProjectPatch = { version: project.version, reason: reason.trim(), reviewStatus, trackingStatus, publicReason: publicReason.trim() };
    if (name.trim() !== project.name) body.name = name.trim();
    if (id !== project.rootdataId) body.rootdataId = id;
    const result = await run("PATCH", `/api/admin/funding-projects/${project.id}`, body, { success: "项目已保存", label: "save-project" });
    if (result) setReason("");
  };
  return <article aria-label={project.name}><Card>
    <div className="flex flex-wrap items-center gap-2"><h2 className="break-words text-[17px] font-semibold text-ink">{project.name}</h2><Badge tone={project.reviewStatus === "pending" ? "warn" : project.reviewStatus === "approved" ? "ok" : "muted"}>{REVIEW_LABELS[project.reviewStatus]}</Badge><Badge>{project.trackingStatus === "watching" ? "持续跟踪" : "已暂停"}</Badge><span className="num text-[12px] text-ink-4">#{project.id}</span>{project.reviewStatus === "approved" && project.trackingStatus === "watching" && <Link to={`/funding/${project.id}`} className="ml-auto text-[12.5px] text-accent">查看公开页 →</Link>}</div>
    <section aria-label={`${project.name} 自动审核`} className="mt-4 rounded-control bg-accent-softer p-3">
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-[13px] font-medium text-ink-2">最近自动审核</h3>{autoReview && <Badge tone={autoReview.decision === "approve" ? "ok" : autoReview.decision === "defer" ? "warn" : "muted"}>{AUTO_REVIEW_LABELS[autoReview.decision]}</Badge>}</div>
      {autoReview ? <><p className="mt-2 whitespace-pre-line break-words text-[13px] leading-relaxed text-ink-2">{autoReview.reason}</p><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-4"><span className="break-all">模型：{autoReview.model}</span><time dateTime={autoReview.reviewedAt}>{fullDateTime(autoReview.reviewedAt)}</time></div></> : <p className="mt-2 text-[13px] text-ink-3">等待自动审核，完成后会在这里显示结果与理由。</p>}
      {autoReview?.decision === "approve" && project.reviewStatus === "pending" && <p className="mt-2 text-[12px] leading-relaxed text-amber-ink">当前保留为候选，以上历史结果不代表当前已入选。</p>}
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">{project.trackingStatus === "paused" ? "此项目已暂停，自动审核不会恢复跟踪与展示。" : "新报道或项目资料变化后会自动重新评估，无需逐项人工审批。"}</p>
      {project.autoReviewError && <p className="mt-2 break-words text-[12px] text-amber-ink">最近自动审核提示：{project.autoReviewError}</p>}
    </section>
    <div className="mt-3 rounded-control bg-bg-sunk p-3"><h3 className="text-[12.5px] font-medium text-ink-2">融资报道</h3>{funding.length ? <ul className="mt-2 space-y-3">{funding.map((evidence) => <li key={evidence.articleId}><p className="text-[13px] leading-relaxed"><ExternalLink href={evidence.url}>{evidence.title}</ExternalLink></p><p className="mt-1 text-[12px] text-ink-4">{evidence.sourceName} · <Time at={evidence.publishedAt} /></p>{evidence.summary && <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{evidence.summary}</p>}</li>)}</ul> : <p className="mt-2 text-[12.5px] text-amber-ink">当前无有效公开融资报道，此项目不会对外展示。</p>}</div>
    <p className="mt-3 text-[12px] text-ink-3">{project.profileStatus === "linked" ? "RootData 基础档案已关联" : "RootData 基础档案待补充"}{project.rootdataUrl && <> · <ExternalLink href={project.rootdataUrl}>核对档案</ExternalLink></>}{project.profileUpdatedAt && <> · <Time at={project.profileUpdatedAt} /></>}</p>
    {project.lastError && <p className="mt-2 break-words rounded-control bg-amber-soft px-3 py-2 text-[12px] text-amber-ink">最近处理提示：{project.lastError}</p>}
    <details className="mt-4 border-t border-line-soft pt-3"><summary className="cursor-pointer text-[13px] font-medium text-ink-3">手动调整（可选）</summary>
    <form onSubmit={save} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-[12.5px] text-ink-3"><span>项目名称</span><Input required minLength={2} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="space-y-1 text-[12.5px] text-ink-3"><span>RootData 项目 ID（选填）</span><Input type="number" inputMode="numeric" min={1} step={1} value={rootdataId} placeholder="未匹配时可手动核对后填写" onChange={(event) => setRootdataId(event.target.value)} /></label>
        <label className="space-y-1 text-[12.5px] text-ink-3"><span>入选状态</span><Select aria-label="入选状态" value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as FundingAdminProject["reviewStatus"])}>{Object.entries(REVIEW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
        <label className="space-y-1 text-[12.5px] text-ink-3"><span>跟踪状态</span><Select aria-label="跟踪状态" value={trackingStatus} onChange={(event) => setTrackingStatus(event.target.value as FundingAdminProject["trackingStatus"])}><option value="watching">持续跟踪</option><option value="paused">暂停跟踪与展示</option></Select></label>
      </div>
      <label className="block space-y-1 text-[12.5px] text-ink-3"><span>公开跟踪依据</span><Textarea rows={2} maxLength={500} value={publicReason} onChange={(event) => setPublicReason(event.target.value)} placeholder="只填写能够由上述来源核对的理由" /></label>
      <label className="block space-y-1 text-[12.5px] text-ink-3"><span>本次操作说明（仅后台）</span><Input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明核对了哪些来源，或为什么修改、排除、暂停" /></label>
      <p className="text-[11.5px] leading-relaxed text-ink-4">手动调整后，资料变化仍会触发自动重评；暂停跟踪会一直保留，直到手动恢复。修改名称会重新匹配档案，填写 ID 前请确认是同一项目。</p>
      {error && <p role="alert" className="text-[12.5px] text-hot">{error}</p>}
      <Button type="submit" tone="primary" busy={busy}>保存调整</Button>
    </form>
    </details>
  </Card></article>;
}

export default function FundingAdminPage() {
  const { items, status } = useLoaderData<typeof loader>();
  const [filter, setFilter] = useState("");
  const shown = items.filter((project) => !filter || project.reviewStatus === filter);
  return <AdminPage title="融资项目" subtitle="模型根据公开报道自动筛选值得跟踪的项目，资料变化后重新评估。" actions={<Link to="/funding" className="text-[13px] text-accent">公开页面 →</Link>}>
    <div className="mb-5 grid gap-3 sm:grid-cols-3"><Stat label="候选项目" value={items.filter((project) => project.reviewStatus === "pending").length} hint="证据不足时保留候选，等待新资料" /><Stat label="RootData 档案同步" value={!status.configured ? "待配置" : status.enabled ? "已启用" : "未启用"} hint={status.configured ? "融资发现仍由站内公开新闻提供" : "等待配置服务端 API Key"} /><Stat label="RootData 剩余额度" value={status.quota ? `${status.quota.credits} / ${status.quota.totalCredits}` : "尚未读取"} hint={status.quota ? <>查询于 <Time at={status.quota.checkedAt} /></> : "以最近一次额度查询为准"} /></div>
    <div className="mb-4 flex flex-wrap gap-2" aria-label="入选状态筛选">{[["", "全部"], ...Object.entries(REVIEW_LABELS)].map(([value, label]) => <Button key={value} tone={filter === value ? "primary" : "secondary"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}</div>
    <div className="space-y-4">{shown.length ? shown.map((project) => <ReviewProject key={`${project.id}-${project.version}`} project={project} />) : <Card><Empty>{filter === "pending" ? "暂无候选项目。新融资线索会自动进入审核。" : "此状态下暂无项目。"}</Empty></Card>}</div>
  </AdminPage>;
}
