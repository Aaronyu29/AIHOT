import type { AnalysisClaim, FundingProject } from "../contracts";
import { fullDateTime } from "../../../apps/web/app/lib/format";
import { ExternalLink } from "./components";

const KINDS = { fact: "来源披露", assessment: "模型判断", unknown: "信息未确认" } as const;
const CONFIDENCE = { low: "较低", medium: "中等", high: "较高" } as const;

function Claim({ claim, project }: { claim: AnalysisClaim; project: FundingProject }) {
  return <div>
    <span className={`inline-block rounded-mark px-1.5 py-0.5 text-[10.5px] font-medium ${claim.kind === "fact" ? "bg-accent-soft text-accent" : claim.kind === "unknown" ? "bg-amber-soft text-amber-ink" : "bg-bg-sunk text-ink-3"}`}>{KINDS[claim.kind]}</span>
    <p className="mt-2 whitespace-pre-line break-words text-[13.5px] leading-[1.8] text-ink-2">{claim.text}</p>
    {claim.citations.length > 0 && <details className="mt-2 text-[12px]">
      <summary className="cursor-pointer text-accent marker:text-ink-4">查看依据 · {claim.citations.length}</summary>
      <ul className="mt-2 space-y-3 border-l-2 border-line pl-3">{claim.citations.map((citation, index) => {
        const evidence = project.evidence.find((item) => item.articleId === citation.sourceId);
        const rootdata = citation.sourceId === "rootdata";
        return <li key={`${citation.sourceId}-${index}`}><ExternalLink href={rootdata ? project.rootdataUrl : evidence?.url ?? null}>{rootdata ? "RootData 项目档案" : evidence?.title ?? "原始来源"}</ExternalLink><blockquote className="mt-1 whitespace-pre-line break-words leading-relaxed text-ink-3">“{citation.quote}”</blockquote></li>;
      })}</ul>
    </details>}
  </div>;
}

export function ProjectAnalysisPanel({ project }: { project: FundingProject }) {
  const analysis = project.analysis;
  return <section aria-labelledby="analysis-heading" className="card p-4 sm:p-5">
    <header className="border-b border-line-soft pb-4"><h2 id="analysis-heading" className="text-[16px] font-semibold text-ink">项目分析</h2><p className="mt-1 text-[12px] leading-relaxed text-ink-4">结合项目档案与公开报道，了解业务、所在链、宣发和后续前景。</p></header>
    {!analysis ? <p className="py-6 text-[13px] leading-relaxed text-ink-3">分析待生成，现有资料仍可阅读。资料不足的部分会保留为未确认。</p> : <>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-4"><span>模型：{analysis.model}</span><span>分析把握：{CONFIDENCE[analysis.confidence]}</span><time dateTime={analysis.generatedAt}>{fullDateTime(analysis.generatedAt)}</time></div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">「来源披露」转述资料中的信息；「模型判断」是基于现有资料的分析，后续可能变化。</p>
      <div className="divide-y divide-line-soft">{([
        ["做什么", analysis.whatItDoes], ["所在链与技术环境", analysis.chainAssessment], ["宣发与公开沟通", analysis.promotionAssessment], ["前景判断", analysis.outlook],
      ] as const).map(([title, claim]) => <section key={title} className="py-4"><h3 className="mb-2 text-[13.5px] font-semibold text-ink">{title}</h3><Claim claim={claim} project={project} /></section>)}</div>
      <div className="grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-2">
        <section><h3 className="mb-3 text-[13.5px] font-semibold text-ink">潜在机会</h3>{analysis.opportunities.length ? <ul className="space-y-4">{analysis.opportunities.map((claim, index) => <li key={index}><Claim claim={claim} project={project} /></li>)}</ul> : <p className="text-[13px] text-ink-3">现有资料不足以形成具体判断。</p>}</section>
        <section><h3 className="mb-3 text-[13.5px] font-semibold text-ink">风险与待验证项</h3>{analysis.risks.length ? <ul className="space-y-4">{analysis.risks.map((claim, index) => <li key={index}><Claim claim={claim} project={project} /></li>)}</ul> : <p className="text-[13px] text-ink-3">现有资料不足以完整评估。</p>}</section>
      </div>
      {analysis.watchSignals.length > 0 && <section className="mt-5 rounded-control bg-bg-sunk px-4 py-3"><h3 className="text-[13px] font-semibold text-ink">接下来关注什么</h3><ul className="mt-2 list-disc space-y-1.5 pl-4 text-[13px] leading-relaxed text-ink-3">{analysis.watchSignals.map((signal, index) => <li key={index}>{signal}</li>)}</ul></section>}
    </>}
  </section>;
}
