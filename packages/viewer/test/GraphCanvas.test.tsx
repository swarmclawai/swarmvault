import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphCanvas } from "../src/components/GraphCanvas";
import type { ViewerGraphArtifact, ViewerGraphNode, ViewerGraphPathResult } from "../src/lib";

type CytoscapeHandler = (event: { target: { data: () => ViewerGraphNode } }) => void;

const { mockState, cytoscapeMock, resetMockState } = vi.hoisted(() => {
  const state = {
    handlers: new Map<string, CytoscapeHandler[]>(),
    addClassById: new Map<string, ReturnType<typeof vi.fn>>(),
    removeClass: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn()
  };

  const reset = () => {
    state.handlers = new Map<string, CytoscapeHandler[]>();
    state.addClassById = new Map<string, ReturnType<typeof vi.fn>>();
    state.removeClass = vi.fn();
    state.resize = vi.fn();
    state.destroy = vi.fn();
  };

  const cytoscape = vi.fn(() => ({
    on(eventName: string, selector: string, handler: CytoscapeHandler) {
      const key = `${eventName}:${selector}`;
      const handlers = state.handlers.get(key) ?? [];
      handlers.push(handler);
      state.handlers.set(key, handlers);
    },
    getElementById(id: string) {
      let addClass = state.addClassById.get(id);
      if (!addClass) {
        addClass = vi.fn();
        state.addClassById.set(id, addClass);
      }
      return { addClass };
    },
    elements() {
      return {
        removeClass: state.removeClass
      };
    },
    resize: state.resize,
    destroy: state.destroy
  }));

  return {
    mockState: state,
    cytoscapeMock: cytoscape,
    resetMockState: reset
  };
});

vi.mock("cytoscape", () => ({
  default: cytoscapeMock
}));

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

function sampleGraph(): ViewerGraphArtifact {
  return {
    generatedAt: new Date().toISOString(),
    nodes: [
      {
        id: "node-1",
        type: "concept",
        label: "Node 1",
        sourceIds: ["source-1"],
        projectIds: [],
        communityId: "community-1"
      }
    ],
    edges: [
      {
        id: "edge-1",
        source: "node-1",
        target: "node-1",
        relation: "mentions",
        status: "extracted"
      }
    ],
    hyperedges: [],
    communities: [{ id: "community-1", label: "Community 1", nodeIds: ["node-1"] }]
  };
}

type RenderHandle = {
  cleanup: () => void;
  rerender: (pathResult: ViewerGraphPathResult | null) => void;
};

function renderCanvas(onNodeSelect: (node: ViewerGraphNode | null) => void, pathResult: ViewerGraphPathResult | null = null): RenderHandle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const cyRef = { current: null };

  const render = (nextPathResult: ViewerGraphPathResult | null) => {
    act(() => {
      root.render(
        <GraphCanvas
          graph={sampleGraph()}
          edgeStatusFilter="all"
          communityFilter="all"
          sourceClassFilter="all"
          pathResult={nextPathResult}
          onNodeSelect={onNodeSelect}
          cyRef={cyRef}
        />
      );
    });
  };

  render(pathResult);

  return {
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    rerender: render
  };
}

beforeEach(() => {
  resetMockState();
  cytoscapeMock.mockClear();
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("GraphCanvas", () => {
  it("updates selection state when Cytoscape selects and unselects a node", () => {
    const onNodeSelect = vi.fn();
    const handle = renderCanvas(onNodeSelect);

    const selectHandler = mockState.handlers.get("select:node")?.[0];
    const unselectHandler = mockState.handlers.get("unselect:node")?.[0];

    expect(selectHandler).toBeTruthy();
    expect(unselectHandler).toBeTruthy();

    selectHandler?.({
      target: {
        data: () => sampleGraph().nodes[0] as ViewerGraphNode
      }
    });
    expect(onNodeSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "node-1" }));

    unselectHandler?.({
      target: {
        data: () => sampleGraph().nodes[0] as ViewerGraphNode
      }
    });
    expect(onNodeSelect).toHaveBeenLastCalledWith(null);

    handle.cleanup();
  });

  it("highlights path nodes and edges without relying on node size", () => {
    const handle = renderCanvas(vi.fn());

    handle.rerender({
      from: "node-1",
      to: "node-1",
      found: true,
      nodeIds: ["node-1"],
      edgeIds: ["edge-1"],
      pageIds: [],
      summary: "path"
    });

    expect(mockState.removeClass).toHaveBeenCalledWith("path-node path-edge");
    expect(mockState.addClassById.get("node-1")).toHaveBeenCalledWith("path-node");
    expect(mockState.addClassById.get("edge-1")).toHaveBeenCalledWith("path-edge");

    handle.cleanup();
  });
});
