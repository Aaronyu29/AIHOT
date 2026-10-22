import { Link, useLoaderData } from "react-router";
import type { FundingProject } from "../contracts";
import type { LoaderArgs, MetaFunction } from "../../../apps/web/app/lib/route-types";
import { cachedPage, loadOr404 } from "../../../apps/web/app/lib/api.server";
import { pageReuse } from "../../../apps/web/app/lib/page-reuse";
import { pageMeta } from "../../../apps/web/app/lib/seo";
import { fullDateTime } from "../../../apps/web/app/lib/format";
import { PhoneBar } from "../../../apps/web/app/components/shell/PhoneBar";
import type { Screen } from "../../../apps/web/app/components/shell/screens";
import { EvidenceCard, ExternalLink, ProjectMark, ProjectTags, WatchButton } from "./components";
import { ProjectAnalysisPanel } from "./analysis";

export const handle: Screen = { home: "funding", name: "项目详情" };
export { pageHeaders as headers } from "../../../apps/web/app/lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ params, request }: LoaderArgs) {
  const upstream = new Headers();
  const project = await loadOr404<FundingProject>(`/api/site/funding-projects/${encodeURIComponent(params.id ?? "")}`, { signal: request.signal, responseHeaders: upstream });
  return cachedPage(60, { project }, upstream);
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: data }) => pageMeta({
  title: data ? `${data.project.name} · 项目跟踪` : "项目跟踪",
  description: data?.project.description || "查看项目的融资报道、跟踪依据与后续公开动态。",
  path: data ? `/funding/${data.project.id}` : "/funding",
});

export default function ProjectPage() {
  const { project } = useLoaderData<typeof loader>();
  const funding = project.evidence.filter((item) => item.kind === "funding");
  const updates = project.evidence.filter((item) => item.kind === "update");
  return <div className="pb-12">
    <PhoneBar back={{ to: "/funding", label: "融资项目" }} title={project.name} />
    <Link to="/funding" className="mb-6 hidden text-[12.5px] text-ink-3 hover:text-accent lg:inline-flex">← 全部融资项目</Link>
    <header className="py-4 lg:pt-0">
      <div className="flex items-start gap-3 sm:gap-4"><ProjectMark project={project} /><div className="min-w-0 flex-1"><p className="mb-1 text-[11px] font-medium text-accent">项目跟踪</p><h1 data-page-title="" className="break-words text-[26px] font-semibold leading-tight text-ink sm:text-[30px]">{project.name}</h1></div><WatchButton project={project} /></div>
      <div className="mt-4"><ProjectTags tags={project.tags} /></div>
      <p className="mt-3 text-[12px] text-ink-4">最近公开动态 <time dateTime={project.lastNewsAt} className="num">{fullDateTime(project.lastNewsAt)}</time></p>
    </header>
    <div className="mt-2 grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px] xl:items-start">
      <div className="min-w-0 space-y-5">
        <ProjectAnalysisPanel project={project} />
        <section aria-labelledby="tracking-reasons" className="rounded-card border border-accent/20 bg-accent-softer p-4 sm:p-5"><h2 id="tracking-reasons" className="text-[15px] font-semibold text-ink">为什么跟踪这个项目</h2><p className="mt-1 text-[12px] leading-relaxed text-ink-3">依据以下公开报道整理，项目进展以原始来源为准。</p>{project.reasons.length > 0 ? <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-2">{project.reasons.map((reason, index) => <li key={index} className="flex gap-2"><span aria-hidden="true" className="text-accent">·</span><span>{reason}</span></li>)}</ul> : <p className="mt-3 text-[13px] text-ink-3">已有融资报道，继续关注后续产品与业务进展。</p>}<a href="#funding-evidence" className="mt-3 inline-block text-[12.5px] font-medium text-accent">核对融资报道 ↓</a></section>
        <section id="funding-evidence" aria-labelledby="funding-heading" className="card scroll-mt-20 p-4 sm:p-5"><div className="mb-5 border-b border-line-soft pb-3"><h2 id="funding-heading" className="text-[16px] font-semibold text-ink">融资报道</h2><p className="mt-1 text-[12px] leading-relaxed text-ink-4">金额、轮次与参与方以报道原文为准；此处展示已收录的融资线索。</p></div><div className="divide-y divide-line-soft">{funding.map((evidence) => <EvidenceCard key={evidence.articleId} evidence={evidence} />)}</div></section>
        <section aria-labelledby="updates-heading" className="card p-4 sm:p-5"><div className="mb-5 border-b border-line-soft pb-3"><h2 id="updates-heading" className="text-[16px] font-semibold text-ink">后续动态 <span className="num ml-1 text-[12px] font-normal text-ink-4">{updates.length}</span></h2><p className="mt-1 text-[12px] text-ink-4">由本站公开信源持续补充，按报道时间排列。</p></div>{updates.length > 0 ? <div className="divide-y divide-line-soft">{updates.map((evidence) => <EvidenceCard key={evidence.articleId} evidence={evidence} />)}</div> : <p className="py-5 text-[13px] leading-relaxed text-ink-3">暂未收录后续报道。可以先关注项目，再回来查看最新进展。</p>}</section>
      </div>
      <aside className="space-y-4 xl:sticky xl:top-6">
        <section className="card p-4 sm:p-5" aria-labelledby="profile-heading"><h2 id="profile-heading" className="text-[15px] font-semibold text-ink">项目档案</h2><p className="mt-2 whitespace-pre-line text-[13px] leading-[1.8] text-ink-3">{project.description || "基础介绍尚待补充，先通过融资报道了解项目。"}</p><div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[12.5px]">{project.rootdataUrl && <ExternalLink href={project.rootdataUrl}>RootData 档案</ExternalLink>}{project.website && <ExternalLink href={project.website}>项目官网</ExternalLink>}</div><div className="mt-4 border-t border-line-soft pt-3 text-[11.5px] leading-relaxed text-ink-4">{project.profileStatus === "linked" ? <><p>基础档案来源：RootData</p>{project.profileUpdatedAt && <p className="mt-1">档案同步于 <time dateTime={project.profileUpdatedAt} className="num">{fullDateTime(project.profileUpdatedAt)}</time></p>}</> : <p>RootData 基础档案待匹配，融资线索来自左侧新闻来源。</p>}<p className="mt-2">RootData 免费接口提供基础介绍与标签；本页融资报道及后续动态来自本站收录的公开新闻。</p></div></section>
        <p className="px-1 text-[12px] leading-relaxed text-ink-4">关注保存在当前浏览器中。项目观察帮助整理研究线索，不代表项目质量或投资回报。</p>
      </aside>
    </div>
  </div>;
}
