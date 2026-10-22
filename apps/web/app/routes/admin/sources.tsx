import { SITE } from "@aihot/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/sources";
import type { AdminSources } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { bj, num, pct } from "../../features/admin/format";
import { HEALTH_LABEL, KIND_LABEL, MODE_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, ButtonLink, Card, DataTable, Dot, FilterChips, healthTone, Input, Pager, Select, Stat, Time } from "../../features/admin/ui";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return adminGet<AdminSources>(request, `/api/admin/sources${url.search}`);
}

export const meta: Route.MetaFunction = () => [{ title: `信源 · ${SITE.name} 后台` }];

function QualityRate({ rate, numerator, denominator, label }: { rate: number | null; numerator: number; denominator: number; label: string }) {
  return (
    <div className="whitespace-nowrap" title={label}>
      <div className="font-medium text-ink">{pct(rate)}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-4">{num(numerator)} / {num(denominator)}</div>
    </div>
  );
}

export default function Sources({ loaderData }: Route.ComponentProps) {
  const { rows, totals, page, windowDays, sort, matchedTotal, observedAt } = loaderData;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const changeFilter = (key: string, value: string) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    navigate(`?${next}`, { preventScrollReset: true });
  };
  return (
    <AdminPage
      title="信源"
      subtitle="比较信源的有效产出、重复报道和抓取表现。点进详情可以预览抓取、调整频率与参与方式。"
      actions={<ButtonLink to="/admin/sources/new" tone="primary">新建信源</ButtonLink>}
    >
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="全部" value={num(totals.total)} />
        <Stat label="启用" value={num(totals.enabled)} />
        <Stat label="失败" value={num(totals.failing)} tone={totals.failing ? "bad" : "ok"} />
        <Stat label="不稳定" value={num(totals.degraded)} tone={totals.degraded ? "warn" : undefined} />
      </div>
      <Card pad={false}>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-b border-line p-3">
          <label className="text-[12px] text-ink-3">
            <span className="mb-1 block">统计窗口</span>
            <Select className="!w-auto" value={windowDays} onChange={(e) => changeFilter("window", e.target.value)}>
              {[7, 30, 90].map((days) => <option key={days} value={days}>近 {days} 天</option>)}
            </Select>
          </label>
          <label className="text-[12px] text-ink-3">
            <span className="mb-1 block">质量排序</span>
            <Select className="!w-auto" value={sort} onChange={(e) => changeFilter("sort", e.target.value)}>
              <option value="health">默认健康度</option>
              <option value="low-effective">低有效产出（有效率）</option>
              <option value="high-duplicate">高同事件重复率</option>
              <option value="low-selected">低精选率</option>
              <option value="unstable">低抓取成功率</option>
            </Select>
          </label>
          <div className="min-w-0 pb-1 text-[12px] leading-relaxed text-ink-4">
            <div>近 {windowDays} 天入库 · 匹配 {num(matchedTotal)} 个信源</div>
            <div>截至 {bj(observedAt, true)}</div>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-b border-line p-3 lg:flex-row lg:items-center lg:justify-between">
          <Form method="get" className="flex w-full max-w-md gap-2" preventScrollReset>
            {["kind", "health", "mode", "enabled"].map((k) => sp.get(k) && <input key={k} type="hidden" name={k} value={sp.get(k)!} />)}
            <input type="hidden" name="window" value={windowDays} />
            <input type="hidden" name="sort" value={sort} />
            <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="名称、ID 或地址" aria-label="搜索信源" />
          </Form>
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips param="health" options={[{ value: "", label: "全部" }, { value: "failing", label: "失败" }, { value: "degraded", label: "不稳定" }, { value: "paused", label: "暂停" }]} />
            <Select
              aria-label="类型"
              className="!w-auto"
              value={sp.get("kind") ?? ""}
              onChange={(e) => changeFilter("kind", e.target.value)}
            >
              <option value="">全部类型</option>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </div>
        </div>
        <details className="border-b border-line px-3 py-2 text-[12px] leading-relaxed text-ink-3">
          <summary className="cursor-pointer select-none">统计口径与样本说明</summary>
          <div className="mt-2 space-y-1 pb-1">
            <p>消息按入库时间进入窗口，非原文发布时间；按当前版本的处理结果统计，后续处理会更新数值。排序覆盖全部匹配信源后再分页，无样本的率显示「—」。</p>
            <p>有效消息是分析通过的消息；有效率 = 通过 /（通过 + 拦截）。未判定包含尚未分析、不参与分析或结果不确定的消息；未判定与分析失败不计入有效率分母。回填计入入库和分析统计，并单列数量。</p>
            <p>同事件重复率 = 同一事实的后续报道 / 可比较消息。只统计非回填、已归组且仅对应一个事实的消息；不表示抄袭，也不统计订阅重复抓到的旧条目。</p>
            <p>精选率 = 当前已正式发布且公开展示的精选消息 / 已完成判定的消息。分母包含已拦截，以及分析通过且已完成归组的消息；分析通过但归组未完成的不计入，包含归组等待中或失败的消息。</p>
            <p>抓取按同一窗口内的抓取记录统计，成功率 = 成功 /（成功 + 技术失败）；运行中与预算跳过单列，不计入分母。p95 是成功或技术失败的已完成抓取耗时的第 95 百分位。各项比例下方均列出分子 / 分母。</p>
          </div>
        </details>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/admin/sources/${encodeURIComponent(r.id)}`)}
          columns={[
            {
              key: "name",
              label: "信源",
              render: (r) => (
                <div className="min-w-[180px] max-w-[260px] break-words">
                  <Link to={`/admin/sources/${encodeURIComponent(r.id)}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>
                    {r.name}
                  </Link>
                  <div className="break-all font-mono text-[11.5px] text-ink-4">{r.id}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <Badge>{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                    <Badge tone={r.participation_mode === "editorial" ? "accent" : "muted"}>{MODE_LABEL[r.participation_mode] ?? r.participation_mode}</Badge>
                    <Badge tone="info">{r.tier.replace("_", ".")}</Badge>
                    {r.first_party && <Badge tone="ok">一手</Badge>}
                  </div>
                  {r.health === "failing" && r.last_error && <div className="mt-1 line-clamp-1 text-[12px] text-hot">{r.last_error}</div>}
                </div>
              ),
            },
            {
              key: "health",
              label: "健康",
              render: (r) => (
                <div className="min-w-[115px] whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <Dot tone={r.enabled ? healthTone(r.health) : "muted"} />
                    {r.enabled ? HEALTH_LABEL[r.health] ?? r.health : "已暂停"}
                    {r.fail_count > 0 && <span className="num text-[11.5px] text-ink-4">×{r.fail_count}</span>}
                  </span>
                  <div className="mt-1 text-[11.5px] text-ink-4">上次成功 <Time at={r.last_ok_at} /></div>
                  <div className="text-[11.5px] text-ink-4">每 {r.interval_minutes} 分钟</div>
                </div>
              ),
            },
            {
              key: "effective", label: "有效消息", align: "right",
              render: ({ quality: q }) => (
                <div className="min-w-[145px] whitespace-nowrap">
                  <div className="font-medium text-ink">{num(q.effective)}</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-4">有效率 {pct(q.effectiveRate)} · {num(q.effective)} / {num(q.processed)}</div>
                  <details className="mt-1 text-[11.5px] text-ink-3" onClick={(e) => e.stopPropagation()}>
                    <summary className="cursor-pointer select-none">入库与处理明细</summary>
                    <div className="mt-1">入库 {num(q.received)} · 拦截 {num(q.blocked)}</div>
                    <div>未判定 {num(q.pending)} · 分析失败 {num(q.failed)}</div>
                    <div>归组未完成 {num(q.pendingGrouping)} · 回填 {num(q.backfill)}</div>
                  </details>
                </div>
              ),
            },
            {
              key: "duplicates", label: "同事件重复率", align: "right",
              render: ({ quality: q }) => <QualityRate rate={q.duplicateRate} numerator={q.duplicates} denominator={q.duplicateEvaluated} label="同一事实的后续报道 / 可比较消息" />,
            },
            {
              key: "selected", label: "精选率", align: "right",
              render: ({ quality: q }) => <QualityRate rate={q.selectedRate} numerator={q.selected} denominator={q.selectionEvaluated} label="已公开精选 / 已完成判定" />,
            },
            {
              key: "fetch", label: "抓取成功率", align: "right",
              render: ({ quality: q }) => (
                <div className="min-w-[135px] whitespace-nowrap">
                  <QualityRate rate={q.fetchSuccessRate} numerator={q.fetchOk} denominator={q.fetchOk + q.fetchFailed} label="成功 /（成功 + 技术失败）" />
                  <div className="mt-1 text-[11.5px] text-ink-4">失败 {num(q.fetchFailed)} · p95 {q.fetchP95Ms === null ? "—" : q.fetchP95Ms < 1000 ? `${num(q.fetchP95Ms)} 毫秒` : `${num(q.fetchP95Ms / 1000, 1)} 秒`}</div>
                  {(q.fetchRunning > 0 || q.budgetSkipped > 0) && <div className="text-[11.5px] text-ink-4">运行中 {num(q.fetchRunning)} · 预算跳过 {num(q.budgetSkipped)}</div>}
                </div>
              ),
            },
          ]}
        />
      </Card>
      <Pager page={page} hasMore={page * 100 < matchedTotal} />
    </AdminPage>
  );
}
