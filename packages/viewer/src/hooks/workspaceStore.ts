import { startTransition, useCallback, useEffect, useReducer, useRef } from "react";
import {
  fetchApprovalDetail,
  fetchApprovals,
  fetchCandidates,
  fetchGraphArtifact,
  fetchGraphReport,
  fetchLintFindings,
  fetchWatchStatus,
  type ViewerApprovalDetail,
  type ViewerApprovalSummary,
  type ViewerCandidateRecord,
  type ViewerGraphArtifact,
  type ViewerGraphReport,
  type ViewerLintFinding,
  type ViewerWatchStatus
} from "../lib";

export type WorkspaceState = {
  graph: ViewerGraphArtifact | null;
  graphReport: ViewerGraphReport | null;
  approvals: ViewerApprovalSummary[];
  approvalDetail: ViewerApprovalDetail | null;
  candidates: ViewerCandidateRecord[];
  watchStatus: ViewerWatchStatus | null;
  lintFindings: ViewerLintFinding[];
  loading: boolean;
  errors: {
    graph?: string;
    approval?: string;
    candidate?: string;
    watch?: string;
    lint?: string;
  };
};

type Action =
  | { type: "snapshot"; payload: Partial<WorkspaceState> }
  | { type: "approvalDetail"; payload: { detail: ViewerApprovalDetail | null; error?: string } }
  | { type: "error"; key: keyof WorkspaceState["errors"]; message: string | undefined }
  | { type: "loading"; value: boolean };

export const emptyGraph = (): ViewerGraphArtifact => ({
  generatedAt: "",
  nodes: [],
  edges: [],
  hyperedges: [],
  communities: [],
  pages: []
});

const initialState: WorkspaceState = {
  graph: null,
  graphReport: null,
  approvals: [],
  approvalDetail: null,
  candidates: [],
  watchStatus: null,
  lintFindings: [],
  loading: true,
  errors: {}
};

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "snapshot":
      return {
        ...state,
        ...action.payload,
        errors: { ...state.errors, ...((action.payload as Partial<WorkspaceState>).errors ?? {}) },
        loading: false
      };
    case "approvalDetail":
      return {
        ...state,
        approvalDetail: action.payload.detail,
        errors: { ...state.errors, approval: action.payload.error }
      };
    case "error":
      return { ...state, errors: { ...state.errors, [action.key]: action.message } };
    case "loading":
      return { ...state, loading: action.value };
    default:
      return state;
  }
}

export function useWorkspaceStore() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const errors: WorkspaceState["errors"] = {};
      const [graph, approvals, candidates, watchStatus, lintFindings] = await Promise.all([
        fetchGraphArtifact().catch(() => emptyGraph()),
        fetchApprovals().catch((error: unknown) => {
          errors.approval = error instanceof Error ? error.message : String(error);
          return [] as ViewerApprovalSummary[];
        }),
        fetchCandidates().catch((error: unknown) => {
          errors.candidate = error instanceof Error ? error.message : String(error);
          return [] as ViewerCandidateRecord[];
        }),
        fetchWatchStatus().catch((error: unknown) => {
          errors.watch = error instanceof Error ? error.message : String(error);
          return { generatedAt: "", watchedRepoRoots: [], pendingSemanticRefresh: [] } as ViewerWatchStatus;
        }),
        fetchLintFindings().catch((error: unknown) => {
          errors.lint = error instanceof Error ? error.message : String(error);
          return [] as ViewerLintFinding[];
        })
      ]);
      const graphReport = await fetchGraphReport().catch(() => null);
      startTransition(() => {
        dispatch({
          type: "snapshot",
          payload: {
            graph,
            graphReport,
            approvals,
            candidates,
            watchStatus,
            lintFindings,
            errors
          }
        });
      });
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadApprovalDetail = useCallback(async (approvalId: string | undefined) => {
    if (!approvalId) {
      dispatch({ type: "approvalDetail", payload: { detail: null } });
      return;
    }
    try {
      const detail = await fetchApprovalDetail(approvalId);
      dispatch({ type: "approvalDetail", payload: { detail } });
    } catch (error) {
      dispatch({
        type: "approvalDetail",
        payload: { detail: null, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }, []);

  return { state, refresh, loadApprovalDetail, dispatch };
}
