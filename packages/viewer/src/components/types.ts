import type { Core } from "cytoscape";
import type {
  ViewerApprovalDetail,
  ViewerApprovalStructuredDiff,
  ViewerApprovalSummary,
  ViewerCandidateRecord,
  ViewerGraphArtifact,
  ViewerGraphExplainResult,
  ViewerGraphNode,
  ViewerGraphPathResult,
  ViewerGraphQueryResult,
  ViewerGraphReport,
  ViewerLintFinding,
  ViewerOutputAsset,
  ViewerPagePayload,
  ViewerSearchResult,
  ViewerWatchStatus,
  ViewerWorkspaceBundle
} from "../lib";

export type {
  Core,
  ViewerApprovalDetail,
  ViewerApprovalStructuredDiff,
  ViewerApprovalSummary,
  ViewerCandidateRecord,
  ViewerGraphArtifact,
  ViewerGraphExplainResult,
  ViewerGraphNode,
  ViewerGraphPathResult,
  ViewerGraphQueryResult,
  ViewerGraphReport,
  ViewerLintFinding,
  ViewerOutputAsset,
  ViewerPagePayload,
  ViewerSearchResult,
  ViewerWatchStatus,
  ViewerWorkspaceBundle
};

export type OpenPageFn = (pagePath: string, pageId?: string) => Promise<void>;
export type NavigateNodeFn = (nodeId: string) => void;
