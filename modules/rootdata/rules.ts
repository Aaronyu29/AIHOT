/** A headline creates a review candidate, never a verified investment recommendation. */
export function fundingCandidateName(title: string): string | null {
  const text = title.trim().replace(/^(?:快讯|独家|融资速递)[：:]\s*/, "");
  if (/拟融资|计划融资|寻求融资|传闻|否认|融资豁免|融资规则|融资监管|融资指南|僵尸|关闭|倒闭|shuts? down|seeks? funding|plans? to raise/i.test(text)) return null;
  const patterns = [
    /^(.{2,80}?)\s+(?:raises|raised|secures|secured|closes|closed)\s+(?:a\s+)?(?:[$€£]|\d|seed|series|funding|investment)/i,
    /^(.{2,80}?)\s*(?:宣布)?(?:完成|获得|获|筹集)\s*.{0,45}?(?:融资|种子轮|投资)(?:[，,。\s]|$)/,
    /^(.{2,60}?)\s*为.{2,60}?(?:融资|筹集)\s*[\d$￥]/,
    /^(.{2,60}?)\s*(?:宣布)?(?:融资|募资)\s*[\d$￥]/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    let name = match[1]!.trim();
    // Financing belongs to the developer, not the product before "开发方".
    name = name.replace(/^.*开发方\s*/, "").replace(/\s*以\s*[\d.,]+\s*(?:万|亿)?美元估值$/, "").trim();
    if (name.length < 2 || name.length > 80 || /[，,。:：;；!?！？]/.test(name)) return null;
    return name;
  }
  return null;
}

export const normalizedProjectName = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function mentionsProject(title: string, name: string): boolean {
  const escaped = normalizedProjectName(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(normalizedProjectName(title));
}
