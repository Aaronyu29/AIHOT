import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromProjectPage } from "@aihot/backend/sources/project-pages";

test("showcase keeps project summaries and does not turn an event date into publication time", () => {
  const page = `<a href="/showcase">Showcase</a><a href="/showcase/scalpless-15fnr"><h2>ScalpLess</h2><p>A fair onchain draw.</p><div>ETHGlobal Tokyo 2026</div><time>2026-09-27</time></a>
    <a href="/showcase/scalpless-15fnr?utm_source=repeat"><h2>ScalpLess</h2></a>
    <a href="https://elsewhere.example/showcase/unrelated"><h2>Unrelated</h2></a>`;
  const result = fromProjectPage(page, "https://ethglobal.com/showcase", "ethglobal_showcase");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.title, "ScalpLess");
  assert.equal(result[0]!.excerpt, "A fair onchain draw.");
  assert.equal(result[0]!.publishedAt, null);
  assert.equal(result[0]!.publicationTime, null);
  assert.equal((result[0]!.raw as any).eventLabel, "ETHGlobal Tokyo 2026");
  assert.equal((result[0]!.raw as any).eventType, "prototype");
});

test("CSX directory reads literal metadata without executing handlers or claiming cohort dates", () => {
  const page = `<button @click="openModal({ name: 'Builder', logo: '', url: 'https://builder.example/' }); throw new Error('never evaluate')">Builder</button>
    <button @click="openModal({ name: 'Builder', url: 'https://www.builder.example/?utm_source=duplicate' })">Duplicate</button>
    <button @click="openModal({ name: 'Bad', url: 'javascript:alert(1)' })">Bad</button>
    <button @click="openModal({ name: 'No link' })">No link</button>`;
  const result = fromProjectPage(page, "https://a16zcrypto.com/accelerator/", "csx_accelerator");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.url, "https://a16zcrypto.com/accelerator/#companies");
  assert.match(result[0]!.excerpt!, /https:\/\/builder\.example\//);
  assert.equal(result[0]!.title, "a16z CSX: Builder");
  assert.equal(result[0]!.publishedAt, null);
  assert.equal(result[0]!.bodyStatus, "none");
  assert.equal((result[0]!.raw as any).listingUrl, "https://a16zcrypto.com/accelerator/");
  assert.equal((result[0]!.raw as any).eventType, "accelerator_directory");
});

test("EASY keeps original announcement URLs, separates seasons, and ignores application deadlines", () => {
  const page = (season: number) => `<div class="hero-eyebrow">Season ${season} · By YZi Labs</div><h1>Build From Bangkok.</h1>
    <p class="hero-sub">Build together.</p><section id="program"><p>A founder program.</p></section>
    <time>2026-09-21T23:59:00-07:00</time>
    <a href="https://www.yzilabs.com/blog/meet-the-cohort">Meet the Cohort ↗</a>
    <a href="https://www.yzilabs.com/blog/meet-the-cohort?utm_source=repeat">Meet the Cohort ↗</a>
    <a href="https://x.com/YZiLabs/status/123">Demo Day</a>`;
  const first = fromProjectPage(page(5), "https://www.yzilabs.com/easy-residency", "easy_residency");
  const again = fromProjectPage(page(5), "https://www.yzilabs.com/easy-residency", "easy_residency");
  const next = fromProjectPage(page(6), "https://www.yzilabs.com/easy-residency", "easy_residency");
  assert.equal(first.length, 2);
  assert.equal(first[0]!.url, "https://www.yzilabs.com/blog/meet-the-cohort");
  assert.equal(first[0]!.identityKey, "url:https://yzilabs.com/blog/meet-the-cohort");
  assert.equal(first[1]!.excerpt, "A founder program.");
  assert.equal(first[1]!.identityKey, again[1]!.identityKey);
  assert.notEqual(first[1]!.identityKey, next[1]!.identityKey);
  assert.ok(first.every(item => item.publishedAt === null && item.publicationTime === null));
});
