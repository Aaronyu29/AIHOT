import { z } from "zod";
import { defineServerModule } from "@aihot/backend/modules";
import { actorOf } from "@aihot/backend/admin/auth";
import { adminHandler } from "../../apps/api/src/routes/admin-auth.ts";
import { listFundingProjects, fundingProject } from "./publication.ts";
import { listFundingAdmin, syncFundingProjects, updateFundingProject } from "./tracking.ts";
import { analyzeFundingProjects } from './analysis.ts';

export default defineServerModule({
  name: "rootdata",
  models: {rootdataAnalysis: {label: '融资项目分析（业务、所在链、宣发与前景）', env: 'ROOTDATA_ANALYSIS_MODEL', purposes: ['rootdata_project_analysis']}},
  http(app) {
    app.get("/api/site/funding-projects", async (request, reply) => {
      const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(10000).optional(),
        q: z.string().max(100).optional(), tag: z.string().max(100).optional() }).safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
      reply.header("Cache-Control", "no-store");
      return listFundingProjects(parsed.data);
    });
    app.get("/api/site/funding-projects/:id", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const id = Number((request.params as { id: string }).id);
      if (!Number.isSafeInteger(id) || id <= 0) return reply.code(404).send({ error: "not_found" });
      const item = await fundingProject(id);
      return item ?? reply.code(404).send({ error: "not_found" });
    });
    app.get("/api/admin/funding-projects", adminHandler(async () => listFundingAdmin()));
    app.patch("/api/admin/funding-projects/:id", adminHandler(async (request, reply, admin) => {
      const id = Number((request.params as { id: string }).id);
      if (!Number.isSafeInteger(id) || id <= 0) return reply.code(404).send({ error: "not_found" });
      return await updateFundingProject(id, request.body, actorOf(admin)) ?? reply.code(404).send({ error: "not_found" });
    }));
  },
  schedules: [
    { name: "rootdata.sync", cron: "*/15 * * * *", missed: "once", run: syncFundingProjects },
    { name: "rootdata.analysis", cron: "7,22,37,52 * * * *", missed: "once", run: analyzeFundingProjects },
  ],
  admin: { counts: { funding: async () => (await listFundingAdmin()).items.filter((p) => p.reviewStatus === "pending").length } },
});
