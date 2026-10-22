import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import * as cheerio from "cheerio";
import type { FundingAdminProject, FundingProject, FundingProjectPatch } from "../../../modules/rootdata/contracts.ts";
import { fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";

const project: FundingProject = {
  id: 17, name: "Orbit Labs", description: "提供链上开发工具与数据服务。", logo: null, tags: ["基础设施", "开发工具"],
  rootdataUrl: "https://www.rootdata.com/Projects/detail/Orbit", website: "https://example.org/orbit",
  profileStatus: "linked", trackingStatus: "watching", profileUpdatedAt: "2026-10-20T01:00:00Z", lastNewsAt: "2026-10-21T01:00:00Z",
  reasons: ["公开融资报道披露了研发计划，可继续跟进产品落地。"], evidence: [
    { articleId: "orbit-update", title: "Orbit Labs 发布开发者测试网", summary: "项目宣布开放开发者测试。", url: "https://example.org/update", sourceName: "项目公告", publishedAt: "2026-10-21T01:00:00Z", kind: "update" },
    { articleId: "orbit-funding", title: "Orbit Labs 宣布完成种子轮融资", summary: "融资将用于开发工具建设。", url: "https://example.org/funding", sourceName: "融资报道来源", publishedAt: "2026-10-20T01:00:00Z", kind: "funding" },
  ],
  analysis: {
    generatedAt: "2026-10-21T02:00:00Z", model: "fixture-model", confidence: "low",
    whatItDoes: { text: "提供开发工具。", kind: "fact", citations: [{ sourceId: "rootdata", quote: "链上开发工具" }] },
    chainAssessment: { text: "尚无足够证据确认所部署的链。", kind: "unknown", citations: [] },
    promotionAssessment: { text: "项目通过公告披露开发者测试。", kind: "fact", citations: [{ sourceId: "orbit-update", quote: "开放开发者测试" }] },
    outlook: { text: "产品落地仍需后续验证。", kind: "assessment", citations: [{ sourceId: "orbit-funding", quote: "开发工具建设" }] },
    opportunities: [], risks: [], watchSignals: ["测试网开发者的实际使用情况"],
  },
};
const review: FundingAdminProject = { ...project, reviewStatus: "pending", version: 4, rootdataId: 217, publicReason: project.reasons[0], lastError: null };
let submitted: FundingProjectPatch | undefined;
const requests: string[] = [];
const api = fakeApi(async (url, response, request) => {
  requests.push(url.pathname + url.search);
  if (url.pathname === "/api/site/funding-projects") {
    if (url.searchParams.get("q") === "empty") return { items: [], total: 0, notice: "RootData 仅提供项目基础档案，融资信息来自公开报道。" };
    return { items: [project], total: 25, notice: "RootData 仅提供项目基础档案，融资信息来自公开报道。" };
  }
  if (url.pathname === "/api/site/funding-projects/17") return project;
  if (url.pathname === "/api/site/funding-projects/18") return { ...project, id: 18, analysis: null };
  if (url.pathname === "/api/site/funding-projects/503") { response.statusCode = 503; return { code: "unavailable" }; }
  if (url.pathname === "/api/admin/me") return { name: "Reviewer", csrf: "fixture-csrf", dev: true };
  if (url.pathname === "/api/admin/nav-counts") return {};
  if (url.pathname === "/api/admin/funding-projects") return { items: [review], status: { enabled: false, configured: false, quota: null } };
  if (url.pathname === "/api/admin/funding-projects/17" && request.method === "PATCH") {
    assert.equal(request.headers["x-csrf-token"], "fixture-csrf");
    let body = "";
    for await (const chunk of request) body += chunk;
    submitted = JSON.parse(body);
    return { ok: true };
  }
});
let web: WebServer;
let browser: Browser;
before(async () => {
  web = await startWebServer(api);
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chromium" });
});
after(async () => { await browser?.close(); await web?.stop(); });

test("funding pages expose news evidence and keep RootData attribution limited to profiles", async () => {
  const list = await fetch(`${web.origin}/funding?q=Orbit&page=2`);
  assert.equal(list.status, 200, web.logs());
  const $list = cheerio.load(await list.text());
  assert.match($list("main").text(), /最近融资线索/);
  assert.match($list("main").text(), /RootData 仅提供项目基础档案/);
  assert.match($list("main").text(), /融资报道来源/);
  assert.ok(requests.some((path) => path.includes("offset=24") && path.includes("q=Orbit")));
  const detail = await fetch(`${web.origin}/funding/17`);
  assert.equal(detail.status, 200, web.logs());
  const $detail = cheerio.load(await detail.text());
  assert.match($detail("#funding-evidence").text(), /完成种子轮融资/);
  assert.doesNotMatch($detail("#funding-evidence").text(), /开发者测试网/);
  assert.match($detail("section[aria-labelledby='updates-heading']").text(), /开发者测试网/);
  assert.equal($detail("#funding-evidence a[href='https://example.org/funding']").length, 1);
  assert.match($detail("aside").text(), /基础档案来源：RootData/);
  const analysis = $detail("section[aria-labelledby='analysis-heading']");
  assert.match(analysis.text(), /来源披露/);
  assert.match(analysis.text(), /模型判断/);
  assert.match(analysis.text(), /尚无足够证据确认所部署的链/);
  assert.equal(analysis.find("a[href='https://example.org/update']").length, 1);
  const pending = cheerio.load(await (await fetch(`${web.origin}/funding/18`)).text());
  assert.match(pending("main").text(), /分析待生成，现有资料仍可阅读/);
  assert.equal((await fetch(`${web.origin}/funding/999`)).status, 404);
  assert.equal((await fetch(`${web.origin}/funding/503`)).status, 503);
  const empty = cheerio.load(await (await fetch(`${web.origin}/funding?q=empty`)).text());
  assert.match(empty("main").text(), /没有找到符合条件的项目/);
});

test("phone reader can follow projects, return to current updates and distinguish unavailable from failed reads", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await visit(page, `${web.origin}/funding`);
    await expect(page.getByRole("link", { name: "融资", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关注 Orbit Labs", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消关注 Orbit Labs", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("link", { name: "我关注的1", exact: true }).click();
    await expect(page.getByRole("link", { name: "查看项目与来源" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "取消关注 Orbit Labs", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "查看项目与来源" }).click();
    await expect(page.getByRole("heading", { name: "后续动态 1" })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.evaluate(() => localStorage.setItem("funding-project-watchlist-v1", JSON.stringify([{ id: 999, name: "已撤回项目" }, { id: 503, name: "暂时故障项目" }])));
    await visit(page, `${web.origin}/funding?view=watching`);
    await expect(page.getByText("该项目目前未公开展示，关注记录已保留。")).toBeVisible();
    await expect(page.getByText("暂时未能读取动态，关注记录已保留。")).toBeVisible();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("funding-project-watchlist-v1")!).length), 2);
  } finally { await context.close(); }
});

test("review form sends the checked project, version and audit reason with the admin session", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await visit(page, `${web.origin}/admin/funding`);
    await page.getByLabel("项目名称", { exact: true }).fill("Orbit Network");
    await page.getByLabel("审核状态", { exact: true }).selectOption("approved");
    await page.getByLabel("本次操作说明（仅后台）").fill("已核对项目官网与融资公告，为同一项目。");
    await page.getByRole("button", { name: "保存审核结果" }).click();
    await expect.poll(() => submitted?.reviewStatus).toBe("approved");
    assert.equal(submitted?.version, 4);
    assert.equal(submitted?.name, "Orbit Network");
    assert.equal(submitted?.rootdataId, undefined, "a renamed project must let the backend clear its previous profile mapping");
    assert.match(submitted?.reason ?? "", /已核对/);
  } finally { await context.close(); }
});

test("project pages and navigation fit phone and desktop in both themes", async () => {
  for (const width of [360, 1440]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript((value) => localStorage.setItem("aihot-theme", value), theme);
    const page = await context.newPage();
    try {
      for (const path of ["/funding", "/funding/17"]) {
        await visit(page, `${web.origin}${path}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${path} at ${width}/${theme}`);
        await expect(page.getByRole("button", { name: "关注 Orbit Labs", exact: true })).toBeVisible();
        if (process.env.FUNDING_SCREENSHOTS_DIR) await page.screenshot({ path: `${process.env.FUNDING_SCREENSHOTS_DIR}/funding-${path.endsWith("17") ? "detail" : "list"}-${width}-${theme}.png`, fullPage: true });
      }
    } finally { await context.close(); }
  }
});
