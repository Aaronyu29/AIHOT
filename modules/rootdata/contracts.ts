export interface FundingEvidence {
  articleId: string;
  title: string;
  summary: string;
  url: string;
  sourceName: string;
  publishedAt: string;
  kind: "funding" | "update";
}

export interface FundingProject {
  id: number;
  name: string;
  description: string;
  logo: string | null;
  tags: string[];
  rootdataUrl: string | null;
  website: string | null;
  profileStatus: "pending" | "linked";
  trackingStatus: "watching" | "paused";
  profileUpdatedAt: string | null;
  lastNewsAt: string;
  reasons: string[];
  evidence: FundingEvidence[];
  analysis?: ProjectAnalysis | null;
}

export interface AnalysisClaim {
  text: string;
  kind: "fact" | "assessment" | "unknown";
  citations: Array<{ sourceId: string; quote: string }>;
}

export interface ProjectAnalysis {
  generatedAt: string;
  model: string;
  confidence: "low" | "medium" | "high";
  whatItDoes: AnalysisClaim;
  chainAssessment: AnalysisClaim;
  promotionAssessment: AnalysisClaim;
  outlook: AnalysisClaim;
  opportunities: AnalysisClaim[];
  risks: AnalysisClaim[];
  watchSignals: string[];
}

export interface FundingProjectList {
  items: FundingProject[];
  total: number;
  notice: string;
}

export interface FundingAdminProject extends FundingProject {
  reviewStatus: "pending" | "approved" | "rejected";
  version: number;
  rootdataId: number | null;
  publicReason: string;
  lastError: string | null;
  autoReview?: {decision: 'approve' | 'defer' | 'reject'; reason: string; reviewedAt: string; model: string} | null;
  autoReviewError?: string | null;
}

export interface FundingStatus {
  enabled: boolean;
  configured: boolean;
  quota: { credits: number; totalCredits: number; checkedAt: string } | null;
}

export interface FundingAdminList {
  items: FundingAdminProject[];
  status: FundingStatus;
}

export interface FundingProjectPatch {
  version: number;
  reason: string;
  name?: string;
  reviewStatus?: FundingAdminProject["reviewStatus"];
  trackingStatus?: FundingProject["trackingStatus"];
  rootdataId?: number | null;
  publicReason?: string;
}
