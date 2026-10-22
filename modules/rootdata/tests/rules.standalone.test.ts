import assert from "node:assert/strict";
import { test } from "node:test";
import { fundingCandidateName, mentionsProject } from "../rules.ts";

test("funding headlines become review candidates with the financing entity", () => {
  assert.equal(fundingCandidateName("Dataline 为 AI 智能体去中心化数据网络融资 1060 万美元，并计划进行 ICO"), "Dataline");
  assert.equal(fundingCandidateName("HoneyB 开发方 Nectar Group 以 3000 万美元估值完成 500 万美元种子轮融资"), "Nectar Group");
  assert.equal(fundingCandidateName("Example Labs raises $10 million in seed funding"), "Example Labs");
  assert.equal(fundingCandidateName("Example 完成 1000 万美元种子轮融资"), "Example");
});

test("regulation, historical failure, and proposed fundraising are not new funding", () => {
  for (const title of ["SEC 拟提高融资豁免门槛", "僵尸链过半，曾融资数亿美元的项目关闭", "Example 计划融资 1000 万美元", "Polymarket 治理提案引发争论"]) {
    assert.equal(fundingCandidateName(title), null, title);
  }
  assert.equal(mentionsProject("Storager launches new feature", "Rage"), false);
  assert.equal(mentionsProject("Example Labs launches mainnet", "Example Labs"), true);
});
