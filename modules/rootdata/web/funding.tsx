import { useEffect, useState } from "react";
import { Form, Link, useLoaderData } from "react-router";
import type { FundingProject, FundingProjectList } from "../contracts";
import type { LoaderArgs, MetaFunction } from "../../../apps/web/app/lib/route-types";
import { cachedPage, loadOr404 } from "../../../apps/web/app/lib/api.server";
import { pageReuse } from "../../../apps/web/app/lib/page-reuse";
import { pageMeta } from "../../../apps/web/app/lib/seo";
import { PhoneBar } from "../../../apps/web/app/components/shell/PhoneBar";
import { EmptyState } from "../../../apps/web/app/components/ui/Page";
import { buttonClass } from "../../../apps/web/app/components/ui/Controls";
import type { Screen } from "../../../apps/web/app/components/shell/screens";
import { ProjectCard, WatchButton } from "./components";
import { useWatchlist } from "./watchlist";

export const handle: Screen = { tab: "funding", name: "融资项目" };
export { pageHeaders as headers } from "../../../apps/web/app/lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();
const PAGE_SIZE = 24;

export async function loader({ request }: LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  const tag = (params.get("tag") ?? "").trim().slice(0, 80);
  const watching = params.get("view") === "watching";
  const pageValue = Number(params.get("page") ?? "1");
  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? Math.min(pageValue, 10000) : 1;
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
  if (q) query.set("q", q);
  if (tag) query.set("tag", tag);
  const upstream = new Headers();
  const result = await loadOr404<FundingProjectList>(`/api/site/funding-projects?${query}`, { signal: request.signal, responseHeaders: upstream });
  return cachedPage(60, { ...result, q, tag, page, watching }, upstream);
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: data }) => pageMeta({
  title: data?.watching ? "我关注的项目" : "融资项目",
  description: "从公开报道发现融资项目，结合 RootData 基础档案，查看跟踪依据、原文来源与后续进展。",
  path: "/funding",
  noindex: !!(data?.watching || data?.q || data?.tag || (data?.page && data.page > 1)),
});

type WatchResult = { project: FundingProject } | { unavailable: true } | { error: true };

function WatchedProjects() {
  const watched = useWatchlist();
  const [mounted, setMounted] = useState(false);
  const [results, setResults] = useState<Record<number, WatchResult>>({});
  const [revision, setRevision] = useState(0);
  const ids = watched.map((item) => item.id).join(",");
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!ids) return;
    const controller = new AbortController();
    setResults({});
    const load = async () => {
      const pending = ids.split(",").map(Number);
      // Keep the local watchlist's reads bounded; every answer is rechecked against current publication rules.
      for (let start = 0; start < pending.length && !controller.signal.aborted; start += 5) {
        const batch = await Promise.all(pending.slice(start, start + 5).map(async (id): Promise<[number, WatchResult]> => {
          try {
            const response = await fetch(`/api/site/funding-projects/${id}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), cache: "no-store" });
            if (response.status === 404) return [id, { unavailable: true }];
            if (!response.ok) return [id, { error: true }];
            return [id, { project: await response.json() as FundingProject }];
          } catch {
            return [id, { error: true }];
          }
        }));
        if (!controller.signal.aborted) setResults((current) => ({ ...current, ...Object.fromEntries(batch) }));
      }
    };
    void load();
    return () => controller.abort();
  }, [ids, revision]);

  return <div>
    <p className="mb-4 rounded-tile border border-line bg-surface px-4 py-3 text-[12.5px] leading-relaxed text-ink-3">关注列表保存在这个浏览器中，换设备或清除浏览器数据不会同步。打开这里可查看项目最新公开动态。</p>
    {!mounted ? <p role="status" className="py-8 text-center text-[13px] text-ink-4">正在读取本机关注…</p> : watched.length === 0 ? <div className="card"><EmptyState title="还没有关注项目" action={<Link to="/funding" className={buttonClass()}>浏览融资项目</Link>}>在项目旁点击「关注」，下次就能在这里查看后续进展。</EmptyState></div> : <ul className="grid gap-4 xl:grid-cols-2">
      {watched.map((item) => {
        const result = results[item.id];
        return <li key={item.id}>{result && "project" in result ? <ProjectCard project={result.project} /> : <article className="card p-5"><div className="flex items-start justify-between gap-3"><h2 className="break-words text-[17px] font-semibold text-ink">{item.name}</h2><WatchButton project={item} /></div><p role={result && "error" in result ? "alert" : "status"} className="mt-3 text-[13px] text-ink-3">{!result ? "正在读取最新动态…" : "unavailable" in result ? "该项目目前未公开展示，关注记录已保留。" : "暂时未能读取动态，关注记录已保留。"}</p>{result && "error" in result && <button type="button" onClick={() => setRevision((value) => value + 1)} className="mt-3 text-[13px] text-accent">重试</button>}</article>}</li>;
      })}
    </ul>}
  </div>;
}

export default function FundingPage() {
  const { items, total, notice, q, tag, page, watching } = useLoaderData<typeof loader>();
  const watched = useWatchlist();
  const pageHref = (next: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (tag) params.set("tag", tag);
    if (next > 1) params.set("page", String(next));
    return `/funding${params.size ? `?${params}` : ""}`;
  };
  return <div className="pb-12">
    <PhoneBar title="融资项目" />
    <header className="pb-5 pt-3 lg:pt-1">
      <p className="mb-2 text-[11px] font-medium tracking-[0.12em] text-accent">项目观察</p>
      <h1 data-page-title="" className="text-[28px] font-semibold leading-tight text-ink">发现项目，跟进下一步</h1>
      <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-ink-3">从公开报道发现融资线索，结合 RootData 项目档案，持续记录产品、合作与融资进展。</p>
    </header>
    <div className="mb-6 rounded-card border border-line bg-surface px-4 py-3 text-[12px] leading-relaxed text-ink-3"><span className="font-medium text-ink-2">来源说明 · </span>{notice || "融资信息来自本站收录的公开报道；RootData 提供项目基础档案。覆盖范围取决于已接入信源。"}</div>
    <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <nav aria-label="项目列表" className="flex items-center gap-1 rounded-full bg-bg-sunk p-1 self-start text-[13px] font-medium">
        <Link to="/funding" aria-current={!watching ? "page" : undefined} className={`rounded-full px-4 py-2 ${!watching ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}>最新项目</Link>
        <Link to="/funding?view=watching" aria-current={watching ? "page" : undefined} className={`rounded-full px-4 py-2 ${watching ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}>我关注的{watched.length > 0 && <span className="num ml-1.5 text-accent">{watched.length}</span>}</Link>
      </nav>
      {!watching && <Form method="get" className="flex min-w-0 gap-2"><label className="sr-only" htmlFor="funding-search">搜索项目</label><input id="funding-search" name="q" type="search" defaultValue={q} key={q} maxLength={100} placeholder="搜索项目、简介" className="h-11 min-w-0 flex-1 rounded-full border border-line-strong bg-surface px-4 text-[16px] text-ink outline-none focus:border-accent lg:h-9 lg:text-[13px]" />{tag && <input type="hidden" name="tag" value={tag} />}<button type="submit" className={buttonClass()}>搜索</button></Form>}
    </div>
    {watching ? <WatchedProjects /> : <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-4"><p>{q || tag ? "筛选结果" : "正在跟踪"} <span className="num font-medium text-ink-2">{total}</span> 个项目{tag && ` · ${tag}`}</p>{(q || tag) && <Link to="/funding" className="text-accent">清除筛选</Link>}<span>按最新公开动态排序</span></div>
      {items.length > 0 ? <ul className="grid gap-4 xl:grid-cols-2">{items.map((project) => <li key={project.id}><ProjectCard project={project} /></li>)}</ul> : <div className="card"><EmptyState title={q || tag ? "没有找到符合条件的项目" : page > 1 ? "这一页没有项目" : "融资项目正在准备中"} action={(q || tag || page > 1) ? <Link to="/funding" className={buttonClass()}>查看最新项目</Link> : <Link to="/all" className={buttonClass()}>先看最新动态</Link>}>{q || tag ? "试试项目的其他名称，或清除筛选条件。" : "等待信源同步与项目核对。融资线索确认后，会在这里展示报道来源和后续进展。"}</EmptyState></div>}
      {(page > 1 || page * PAGE_SIZE < total) && <nav aria-label="项目分页" className="mt-6 flex items-center justify-center gap-5">{page > 1 && <Link to={pageHref(page - 1)} className={buttonClass()}>上一页</Link>}<span className="num text-[13px] text-ink-4">第 {page} 页</span>{page * PAGE_SIZE < total && <Link to={pageHref(page + 1)} className={buttonClass()}>下一页</Link>}</nav>}
    </>}
  </div>;
}
