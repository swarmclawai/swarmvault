import type { Core } from "cytoscape";
import type {
  ViewerApprovalDetail,
  ViewerApprovalSummary,
  ViewerCandidateRecord,
  ViewerGraphArtifact,
  ViewerGraphExplainResult,
  ViewerGraphNode,
  ViewerGraphPathResult,
  ViewerGraphQueryResult,
  ViewerGraphReport,
  ViewerOutputAsset,
  ViewerPagePayload,
  ViewerSearchResult,
  ViewerWatchStatus
} from "../lib";

export type {
  Core,
  ViewerApprovalDetail,
  ViewerApprovalSummary,
  ViewerCandidateRecord,
  ViewerGraphArtifact,
  ViewerGraphExplainResult,
  ViewerGraphNode,
  ViewerGraphPathResult,
  ViewerGraphQueryResult,
  ViewerGraphReport,
  ViewerOutputAsset,
  ViewerPagePayload,
  ViewerSearchResult,
  ViewerWatchStatus
};

export type OpenPageFn = (pagePath: string, pageId?: string) => Promise<void>;
export type NavigateNodeFn = (nodeId: string) => void;
