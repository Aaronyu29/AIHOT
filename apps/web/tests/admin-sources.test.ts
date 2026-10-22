import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit, expect, type Browser } from "@playwright/test";
import type { AdminSourceRow, AdminSources, BeforeJson } from "@aihot/contracts/admin";
import { FIXTURE_AT, fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

const noSamples: AdminSourceRow["quality"] = {
  received: 3, processed: 0, effective: 0, blocked: 0, pending: 2, failed: 1, backfill: 1,
  pendingGrouping: 0, selectionEvaluated: 0, selected: 0, duplicateEvaluated: 0, duplicates: 0,
  fetchOk: 0, fetchFailed: 0, fetchRunning: 1, budgetSkipped: 2, fetchP95Ms: null,
  effectiveRate: null, selectedRate: null, duplicateRate: null, fetchSuccessRate: null,
};
function source(id: string, name: string, quality = noSamples): BeforeJson<AdminSourceRow> {
  return {
    id, name, quality, kind: "rss", tier: "tier_1", participation_mode: "editorial", enabled: true,
    health: "ok", fail_count: 0, interval_minutes: 15, last_ok_at: FIXTURE_AT, last_fetch_at: FIXTURE_AT,
    last_error: null, first_party: true, next_fetch_at: null,
  };
}
const waiting = source("waiting", "尚未判定的信源");
const rejected = source("rejected", "已有判定但未通过", {
  ...noSamples, received: 4, processed: 4, blocked: 4, pending: 0, failed: 0, backfill: 0,
  selectionEvaluated: 4, fetchOk: 1, fetchFailed: 1, fetchRunning: 0, budgetSkipped: 0, fetchP95Ms: 350,
  effectiveRate: 0, selectedRate: 0, fetchSuccessRate: 0.5,
});
const measured = source("measured", "有完整统计的信源", {
  received: 12, processed: 8, effective: 6, blocked: 2, pending: 3, failed: 1, backfill: 2,
  pendingGrouping: 1, selectionEvaluated: 7, selected: 2, duplicateEvaluated: 5, duplicates: 3,
  fetchOk: 9, fetchFailed: 1, fetchRunning: 1, budgetSkipped: 2, fetchP95Ms: 1234,
  effectiveRate: 0.75, selectedRate: 2 / 7, duplicateRate: 0.6, fetchSuccessRate: 0.9,
});
const requests: URLSearchParams[] = [];
const api = fakeApi((url) => {
  if (url.pathname === "/api/admin/me") return { name: "Reviewer", csrf: "fixture-csrf", dev: true };
  if (url.pathname === "/api/admin/nav-counts") return {};
  if (url.pathname !== "/api/admin/sources") return;
  requests.push(new URLSearchParams(url.search));
  const windowDays = Number(url.searchParams.get("window") ?? 30) as AdminSources["windowDays"];
  const sort = (url.searchParams.get("sort") ?? "health") as AdminSources["sort"];
  const page = Number(url.searchParams.get("page") ?? 1);
  const paginated = url.searchParams.get("q") === "needle";
  const ordered = sort === "high-duplicate" ? [measured, rejected, waiting] : [waiting, rejected, measured];
  const data: BeforeJson<AdminSources> = {
    windowDays, sort, page, observedAt: FIXTURE_AT, matchedTotal: paginated ? 101 : 3,
    rows: page > 1 ? [source("next-page", "第二页信源")] : ordered,
    totals: { total: 103, enabled: 100, failing: 2, degraded: 1 },
  };
  return data;
});
let web: WebServer;
let chrome: Browser;
let safari: Browser;
before(async () => {
  web = await startWebServer(api);
  chrome = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chromium" });
});
after(async () => { await chrome?.close(); await safari?.close(); await web?.stop(); });

test("source quality shows sample denominators, distinguishes no sample from zero and explains undecided messages", async () => {
  const page = await chrome.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await visit(page, `${web.origin}/admin/sources`);
    await expect(page.getByLabel("统计窗口")).toHaveValue("30");
    await expect(page.getByLabel("质量排序")).toHaveValue("health");
    const waitingRow = page.getByRole("row").filter({ has: page.getByRole("link", { name: waiting.name, exact: true }) });
    await expect(waitingRow.getByRole("cell").nth(2)).toContainText("有效率 — · 0 / 0");
    await expect(waitingRow.getByRole("cell").nth(3)).toHaveText("—0 / 0");
    await expect(waitingRow.getByRole("cell").nth(4)).toHaveText("—0 / 0");
    await expect(waitingRow.getByRole("cell").nth(5)).toContainText("—0 / 0");
    await waitingRow.getByText("入库与处理明细", { exact: true }).click();
    await expect(waitingRow.getByText("未判定 2 · 分析失败 1", { exact: true })).toBeVisible();
    await expect(waitingRow.getByText("归组未完成 0 · 回填 1", { exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).pathname, "/admin/sources", "expanding processing details must not open the source");
    const rejectedRow = page.getByRole("row").filter({ has: page.getByRole("link", { name: rejected.name, exact: true }) });
    await expect(rejectedRow.getByRole("cell").nth(2)).toContainText("有效率 0.0% · 0 / 4");
    await expect(rejectedRow.getByRole("cell").nth(4)).toHaveText("0.0%0 / 4");
    const measuredRow = page.getByRole("row").filter({ has: page.getByRole("link", { name: measured.name, exact: true }) });
    await expect(measuredRow.getByRole("cell").nth(2)).toContainText("有效率 75.0% · 6 / 8");
    await expect(measuredRow.getByRole("cell").nth(3)).toHaveText("60.0%3 / 5");
    await expect(measuredRow.getByRole("cell").nth(4)).toHaveText("28.6%2 / 7");
    await expect(measuredRow.getByRole("cell").nth(5)).toContainText("90.0%9 / 10");
    await expect(measuredRow.getByRole("cell").nth(5)).toContainText("失败 1 · p95 1.2 秒");
    await expect(measuredRow.getByRole("cell").nth(5)).toContainText("运行中 1 · 预算跳过 2");
    await page.getByText("统计口径与样本说明", { exact: true }).click();
    await expect(page.getByText(/消息按入库时间进入窗口，非原文发布时间/)).toBeVisible();
    await expect(page.getByText(/不表示抄袭，也不统计订阅重复抓到的旧条目/)).toBeVisible();
    await expect(page.getByText(/归组未完成的不计入/)).toBeVisible();
    await expect(page.getByText(/未判定包含尚未分析、不参与分析或结果不确定的消息/)).toBeVisible();
  } finally { await page.close(); }
});

test("window, server sorting, search and filters survive pagination and reset the page when changed", async () => {
  const page = await chrome.newPage({ viewport: { width: 1280, height: 960 } });
  const latest = () => Object.fromEntries([...requests.at(-1)!].filter(([key]) => key !== "_routes"));
  try {
    await visit(page, `${web.origin}/admin/sources?kind=rss&health=degraded&mode=editorial&enabled=true&page=2`);
    await page.getByLabel("统计窗口").selectOption("7");
    await expect.poll(latest).toEqual({ kind: "rss", health: "degraded", mode: "editorial", enabled: "true", window: "7" });
    await expect(page.getByLabel("统计窗口")).toHaveValue("7");
    await page.getByLabel("质量排序").selectOption("high-duplicate");
    await expect.poll(latest).toEqual({ kind: "rss", health: "degraded", mode: "editorial", enabled: "true", window: "7", sort: "high-duplicate" });
    await expect(page.getByRole("table").getByRole("link").first()).toHaveText(measured.name);
    await page.getByLabel("搜索信源").fill("needle");
    await page.getByLabel("搜索信源").press("Enter");
    await expect.poll(latest).toEqual({ kind: "rss", health: "degraded", mode: "editorial", enabled: "true", window: "7", sort: "high-duplicate", q: "needle" });
    await page.getByRole("link", { name: "下一页", exact: true }).click();
    await expect(page.getByRole("link", { name: "第二页信源", exact: true })).toBeVisible();
    await expect.poll(latest).toEqual({ kind: "rss", health: "degraded", mode: "editorial", enabled: "true", window: "7", sort: "high-duplicate", q: "needle", page: "2" });
    await expect(page.getByRole("link", { name: "下一页", exact: true })).toHaveCount(0);
    await page.getByLabel("类型", { exact: true }).selectOption("web_list");
    await expect.poll(latest).toEqual({ kind: "web_list", health: "degraded", mode: "editorial", enabled: "true", window: "7", sort: "high-duplicate", q: "needle" });
    await expect(page).toHaveURL(/[?&]kind=web_list(?:&|$)/);
    await page.getByRole("link", { name: "暂停", exact: true }).click();
    await expect.poll(latest).toEqual({ kind: "web_list", health: "paused", mode: "editorial", enabled: "true", window: "7", sort: "high-duplicate", q: "needle" });
    await page.getByLabel("统计窗口").selectOption("90");
    await expect.poll(() => latest().window).toBe("90");
    await expect(page.getByText("近 90 天入库 · 匹配 101 个信源", { exact: true })).toBeVisible();
  } finally { await page.close(); }
});

for (const engine of ["Chromium", "WebKit"] as const) test(`${engine}: source quality stays within phone and desktop widths while its table scrolls`, async () => {
  if (engine === "WebKit") safari ??= await webkit.launch();
  for (const width of [320, 393, 1440]) {
    const page = await (engine === "Chromium" ? chrome : safari).newPage({ viewport: { width, height: 960 }, reducedMotion: "reduce" });
    try {
      await visit(page, `${web.origin}/admin/sources`);
      await expect(page.getByRole("heading", { name: "信源", exact: true })).toBeVisible();
      await page.getByText("统计口径与样本说明", { exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `page at ${width}px`);
      if (width < 600) {
        const scrolled = await page.getByRole("table").evaluate((table) => {
          const viewport = table.parentElement!;
          viewport.scrollLeft = viewport.scrollWidth;
          return viewport.scrollLeft > 0;
        });
        assert.equal(scrolled, true, "wide quality columns remain accessible inside the table");
        const lastColumn = page.getByRole("columnheader", { name: "抓取成功率", exact: true });
        await lastColumn.scrollIntoViewIfNeeded();
        await expect(lastColumn).toBeInViewport();
      }
      if (process.env.SOURCE_QUALITY_SCREENSHOTS_DIR) {
        await page.getByText("统计口径与样本说明", { exact: true }).click();
        await page.getByRole("table").evaluate((table) => { table.parentElement!.scrollLeft = 0; });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${process.env.SOURCE_QUALITY_SCREENSHOTS_DIR}/sources-${engine}-${width}.png`, fullPage: true });
      }
    } finally { await page.close(); }
  }
});
