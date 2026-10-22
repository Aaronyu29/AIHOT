import { defineWebModule } from "../../apps/web/app/modules";
import { IconTrendUp } from "../../apps/web/app/components/icons";

export default defineWebModule({
  name: "rootdata",
  sidebar: { section: "项目观察", items: [{ to: "/funding", label: "融资项目", icon: IconTrendUp }] },
  tabs: [{ key: "funding", to: "/funding", label: "融资", icon: IconTrendUp }],
  tools: [{ to: "/funding?view=watching", label: "我关注的项目", icon: <IconTrendUp size={18} /> }],
  admin: { content: [{ to: "/admin/funding", label: "融资项目" }] },
});
