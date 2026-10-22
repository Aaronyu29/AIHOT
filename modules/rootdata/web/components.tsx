import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { FundingEvidence, FundingProject } from "../contracts";
import { fullDateTime } from "../../../apps/web/app/lib/format";
import { IconArrowUpRight, IconBookmark, IconChevronRight } from "../../../apps/web/app/components/icons";
import { buttonClass } from "../../../apps/web/app/components/ui/Controls";
import { toggleWatch, useWatchlist, type WatchedProject } from "./watchlist";

export function safeUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function ExternalLink({ href, children, className = "" }: { href: string | null; children: ReactNode; className?: string }) {
  const url = safeUrl(href);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 text-accent hover:text-accent-ink ${className}`}>{children}<IconArrowUpRight size={13} className="shrink-0" /></a> : <span>{children}</span>;
}

export function WatchButton({ project }: { project: WatchedProject }) {
  const watched = useWatchlist().some((item) => item.id === project.id);
  const [error, setError] = useState<string | null>(null);
  return <div className="shrink-0">
    <button type="button" aria-label={`${watched ? "取消关注" : "关注"} ${project.name}`} aria-pressed={watched} onClick={() => setError(toggleWatch(project))} className={`${buttonClass(watched ? "primary" : "secondary")} !px-3 !text-[12.5px]`}>
      <IconBookmark size={14} filled={watched} />{watched ? "已关注" : "关注"}
    </button>
    {error && <p role="alert" className="mt-1.5 max-w-48 text-[12px] text-hot">{error}</p>}
  </div>;
}

export function ProjectMark({ project }: { project: FundingProject }) {
  const [failed, setFailed] = useState(false);
  const url = safeUrl(project.logo);
  return <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-tile border border-line bg-bg-sunk text-[20px] font-semibold text-accent">
    {url && !failed ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-contain" onError={() => setFailed(true)} /> : project.name.slice(0, 1).toUpperCase()}
  </span>;
}

export function ProjectTags({ tags }: { tags: string[] }) {
  return tags.length > 0 ? <ul aria-label="项目标签" className="flex flex-wrap gap-1.5">{tags.slice(0, 6).map((tag) => <li key={tag} className="rounded-mark bg-bg-sunk px-2 py-0.5 text-[11.5px] text-ink-3">{tag}</li>)}</ul> : null;
}

export function SourceTime({ evidence }: { evidence: FundingEvidence }) {
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-4"><span className="text-ink-3">{evidence.sourceName}</span><span aria-hidden="true">·</span><time dateTime={evidence.publishedAt} className="num">{fullDateTime(evidence.publishedAt)}</time></div>;
}

export function ProjectCard({ project }: { project: FundingProject }) {
  const funding = project.evidence.find((item) => item.kind === "funding");
  const updates = project.evidence.filter((item) => item.kind === "update");
  return <article className="card flex h-full flex-col p-4 sm:p-5">
    <div className="flex items-start gap-3">
      <ProjectMark project={project} />
      <div className="min-w-0 flex-1"><h2 className="break-words text-[18px] font-semibold leading-snug text-ink"><Link to={`/funding/${project.id}`} className="hover:text-accent">{project.name}</Link></h2><p className="mt-1 text-[11.5px] text-ink-4">{project.profileStatus === "linked" ? "已关联 RootData 档案" : "项目档案待补充"}</p></div>
      <WatchButton project={project} />
    </div>
    {project.description && <p className="mt-3 line-clamp-2 text-[13px] leading-relaxed text-ink-3">{project.description}</p>}
    <div className="mt-3"><ProjectTags tags={project.tags} /></div>
    {funding && <div className="mt-4 border-t border-line-soft pt-3">
      <p className="mb-1.5 text-[11px] font-medium text-accent">最近融资线索</p>
      <h3 className="text-[14px] font-semibold leading-relaxed text-ink"><Link to={`/funding/${project.id}`} className="hover:text-accent">{funding.title}</Link></h3>
      <div className="mt-2"><SourceTime evidence={funding} /></div>
    </div>}
    {project.reasons.length > 0 && <p className="mt-3 rounded-control bg-accent-softer px-3 py-2 text-[12px] leading-relaxed text-ink-2"><span className="font-medium text-accent">跟踪依据 · </span>{project.reasons[0]}</p>}
    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4 text-[12px]">
      <span className="text-ink-4">{updates.length ? `${updates.length} 条后续动态` : "等待后续公开报道"}</span>
      <Link to={`/funding/${project.id}`} className="inline-flex items-center gap-0.5 font-medium text-accent hover:text-accent-ink">查看项目与来源<IconChevronRight size={14} /></Link>
    </div>
  </article>;
}

export function EvidenceCard({ evidence }: { evidence: FundingEvidence }) {
  return <article className="py-5 first:pt-0 last:pb-0">
    <SourceTime evidence={evidence} />
    <h3 className="mt-2 text-[16px] font-semibold leading-relaxed text-ink"><Link to={`/items/${encodeURIComponent(evidence.articleId)}`} className="hover:text-accent">{evidence.title}</Link></h3>
    {evidence.summary && <p className="mt-2 whitespace-pre-line text-[14px] leading-[1.8] text-ink-3">{evidence.summary}</p>}
    <div className="mt-2.5 flex flex-wrap gap-4 text-[12.5px]"><ExternalLink href={evidence.url}>阅读原文</ExternalLink><Link to={`/items/${encodeURIComponent(evidence.articleId)}`} className="text-ink-3 hover:text-accent">站内摘要 →</Link></div>
  </article>;
}
