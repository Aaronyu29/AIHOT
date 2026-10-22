import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "rootdata",
  pages: [
    { path: "funding", file: "web/funding.tsx" },
    { path: "funding/:id", file: "web/project.tsx" },
  ],
  adminPages: [{ path: "admin/funding", file: "web/admin.tsx" }],
  apiPaths: [/^\/api\/site\/funding-projects(?:\/|$)/, /^\/api\/admin\/funding-projects(?:\/|$)/],
});
