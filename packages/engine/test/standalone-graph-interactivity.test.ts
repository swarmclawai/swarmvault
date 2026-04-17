import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderHtmlStandalone } from "../src/graph-export.js";
import { runCoreGraphExplain, runCoreGraphPath, runCoreGraphQuery } from "../src/graph-query-core.js";
import { explainGraphTarget, queryGraph, shortestGraphPath } from "../src/graph-tools.js";
import type { GraphArtifact, GraphEdge, GraphNode, GraphPage } from "../src/types.js";

function makeNode(overrides: Partial<GraphNode> & { id: string; type: GraphNode["type"]; label: string }): GraphNode {
  return {
    confidence: 1,
    sourceIds: [],
    projectIds: [],
    sourceClass: "first_party",
    freshness: "fresh",
    degree: 0,
    ...overrides
  };
}

function makePage(overrides: Partial<GraphPage> & { id: string; path: string; title: string }): GraphPage {
  return {
    kind: "source",
    sourceClass: "first_party",
    sourceIds: [],
    projectIds: [],
    nodeIds: [],
    freshness: "fresh",
    status: "active",
    confidence: 1,
    backlinks: [],
    schemaHash: "h",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    compiledFrom: [],
    managedBy: "system",
    ...overrides
  };
}

function makeEdge(overrides: Partial<GraphEdge> & { id: string; source: string; target: string }): GraphEdge {
  return {
    relation: "related_to",
    status: "extracted",
    evidenceClass: "extracted",
    confidence: 0.8,
    provenance: [],
    ...overrides
  };
}

/**
 * Ten-node graph with fifteen edges, one community, and one hyperedge. Sized
 * to match the brief in spec.md for the standalone interactivity feature.
 */
function sampleGraph(): GraphArtifact {
  const nodes: GraphNode[] = [
    makeNode({ id: "concept:auth", type: "concept", label: "Authentication", pageId: "page:auth", communityId: "c:auth", degree: 5 }),
    makeNode({ id: "concept:session", type: "concept", label: "Session", pageId: "page:session", communityId: "c:auth", degree: 4 }),
    makeNode({
      id: "module:auth-service",
      type: "module",
      label: "auth/service.ts",
      pageId: "page:auth-service",
      communityId: "c:auth",
      degree: 3
    }),
    makeNode({
      id: "module:token-store",
      type: "module",
      label: "auth/tokens.ts",
      pageId: "page:tokens",
      communityId: "c:auth",
      degree: 3
    }),
    makeNode({ id: "symbol:login", type: "symbol", label: "login()", degree: 2 }),
    makeNode({ id: "symbol:logout", type: "symbol", label: "logout()", degree: 2 }),
    makeNode({ id: "entity:user", type: "entity", label: "User Account", pageId: "page:user", degree: 3 }),
    makeNode({ id: "entity:admin", type: "entity", label: "Administrator", degree: 2 }),
    makeNode({ id: "rationale:why-jwt", type: "rationale", label: "Why JWT tokens", degree: 1 }),
    makeNode({ id: "source:readme", type: "source", label: "README", pageId: "page:readme", degree: 2 })
  ];

  const edges: GraphEdge[] = [
    makeEdge({ id: "e1", source: "concept:auth", target: "concept:session", relation: "mentions" }),
    makeEdge({ id: "e2", source: "concept:auth", target: "module:auth-service", relation: "implements" }),
    makeEdge({ id: "e3", source: "module:auth-service", target: "symbol:login", relation: "contains_code" }),
    makeEdge({ id: "e4", source: "module:auth-service", target: "symbol:logout", relation: "contains_code" }),
    makeEdge({ id: "e5", source: "module:auth-service", target: "module:token-store", relation: "imports" }),
    makeEdge({ id: "e6", source: "symbol:login", target: "entity:user", relation: "mentions" }),
    makeEdge({
      id: "e7",
      source: "symbol:login",
      target: "concept:session",
      relation: "mentions",
      evidenceClass: "inferred",
      confidence: 0.6
    }),
    makeEdge({ id: "e8", source: "entity:user", target: "entity:admin", relation: "related_to" }),
    makeEdge({ id: "e9", source: "concept:session", target: "module:token-store", relation: "implements" }),
    makeEdge({ id: "e10", source: "rationale:why-jwt", target: "module:token-store", relation: "justifies" }),
    makeEdge({ id: "e11", source: "source:readme", target: "concept:auth", relation: "mentions", confidence: 0.9 }),
    makeEdge({ id: "e12", source: "source:readme", target: "entity:user", relation: "mentions" }),
    makeEdge({
      id: "e13",
      source: "module:token-store",
      target: "entity:user",
      relation: "mentions",
      evidenceClass: "inferred",
      confidence: 0.55
    }),
    makeEdge({ id: "e14", source: "symbol:logout", target: "entity:user", relation: "mentions" }),
    makeEdge({
      id: "e15",
      source: "concept:auth",
      target: "entity:admin",
      relation: "related_to",
      evidenceClass: "inferred",
      confidence: 0.5
    })
  ];

  const pages: GraphPage[] = [
    makePage({ id: "page:auth", path: "concepts/auth.md", title: "Authentication", kind: "concept", nodeIds: ["concept:auth"] }),
    makePage({ id: "page:session", path: "concepts/session.md", title: "Session", kind: "concept", nodeIds: ["concept:session"] }),
    makePage({
      id: "page:auth-service",
      path: "modules/auth-service.md",
      title: "auth/service.ts",
      kind: "module",
      nodeIds: ["module:auth-service"]
    }),
    makePage({ id: "page:tokens", path: "modules/tokens.md", title: "auth/tokens.ts", kind: "module", nodeIds: ["module:token-store"] }),
    makePage({ id: "page:user", path: "entities/user.md", title: "User Account", kind: "entity", nodeIds: ["entity:user"] }),
    makePage({ id: "page:readme", path: "sources/readme.md", title: "README", kind: "source", nodeIds: ["source:readme"] })
  ];

  return {
    generatedAt: "2026-04-16T00:00:00.000Z",
    nodes,
    edges,
    hyperedges: [
      {
        id: "hyper:auth-flow",
        label: "Authentication Flow",
        relation: "participate_in",
        nodeIds: ["concept:auth", "concept:session", "module:auth-service", "symbol:login"],
        evidenceClass: "extracted",
        confidence: 0.85,
        sourcePageIds: ["page:auth"],
        why: "Login and session coordination live together in the auth flow."
      }
    ],
    communities: [
      { id: "c:auth", label: "Auth Cluster", nodeIds: ["concept:auth", "concept:session", "module:auth-service", "module:token-store"] }
    ],
    sources: [],
    pages
  };
}

/**
 * Strip the embedded vis-network bundle out of the standalone HTML before we
 * hand it to jsdom. jsdom does not implement the Canvas APIs the bundle
 * expects, so pre-parsing the giant minified script wastes several seconds
 * for no test value. We replace it with a tiny shim that satisfies the
 * bootstrap reference to `vis.DataSet` / `vis.Network`.
 */
function sanitizeForJsdom(html: string): string {
  const shim = [
    "window.vis = {",
    "  DataSet: function(items) { this.items = items || []; this.forEach = function(cb) { this.items.forEach(cb); }; this.update = function() {}; },",
    "  Network: function() { this.body = { emitter: { emit: function() {} } }; this.on = function() {}; this.selectNodes = function() {}; this.focus = function() {}; }",
    "};"
  ].join("\n");
  return html.replace(/<script>[\s\S]*?<\/script>/, `<script>${shim}</script>`);
}

function loadStandaloneDom(html: string): { window: JSDOM["window"] } {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(sanitizeForJsdom(html), { runScripts: "dangerously", virtualConsole });
  return { window: dom.window };
}

describe("standalone graph export interactivity", () => {
  it("embeds the full graph payload, runtime helpers, and query/path/explain panels", () => {
    const graph = sampleGraph();
    const html = renderHtmlStandalone(graph);

    // Embedded graph payload (JSON literal with node ids from the sample)
    expect(html).toContain('"concept:auth"');
    expect(html).toContain('"hyper:auth-flow"');
    expect(html).toContain('"Authentication Flow"');

    // Inline runtime helper names
    expect(html).toContain("function runGraphQuery(");
    expect(html).toContain("function runGraphPath(");
    expect(html).toContain("function runGraphExplain(");
    expect(html).toContain("window.runGraphQuery = runGraphQuery");
    expect(html).toContain("window.runGraphPath = runGraphPath");
    expect(html).toContain("window.runGraphExplain = runGraphExplain");

    // UI panels as HTML elements with stable testids
    expect(html).toContain('data-testid="graph-tools"');
    expect(html).toContain('data-testid="graph-query-panel"');
    expect(html).toContain('data-testid="graph-path-panel"');
    expect(html).toContain('data-testid="graph-explain-panel"');
    expect(html).toContain('data-testid="graph-query-input"');
    expect(html).toContain('data-testid="graph-query-run"');
    expect(html).toContain('data-testid="graph-path-from"');
    expect(html).toContain('data-testid="graph-path-to"');
    expect(html).toContain('data-testid="graph-path-find"');
    expect(html).toContain('data-testid="graph-explain-input"');
    expect(html).toContain('data-testid="graph-explain-run"');
  });

  it("produces traversal results that match the server-side queryGraph when no external search is provided", () => {
    const graph = sampleGraph();
    const html = renderHtmlStandalone(graph);
    const { window } = loadStandaloneDom(html);

    const embedded = (
      window as unknown as {
        runGraphQuery: (q: string, traversal: "bfs" | "dfs", budget?: number) => { visitedNodeIds: string[]; traversal: string };
      }
    ).runGraphQuery("Authentication", "bfs");

    const server = queryGraph(graph, "Authentication", []);
    const core = runCoreGraphQuery(graph, "Authentication", { traversal: "bfs" });

    // The server surface with an empty searchResults/semanticMatches falls
    // through to the same match set the standalone embed sees, so the two
    // traversals visit the same nodes in the same order.
    expect(embedded.visitedNodeIds).toEqual(server.visitedNodeIds);
    expect(embedded.visitedNodeIds).toEqual(core.visitedNodeIds);
    expect(embedded.traversal).toBe("bfs");
    expect(embedded.visitedNodeIds[0]).toBe("concept:auth");
  });

  it("runGraphPath returns the same shortest path the server path walker would", () => {
    const graph = sampleGraph();
    const html = renderHtmlStandalone(graph);
    const { window } = loadStandaloneDom(html);

    const embedded = (
      window as unknown as {
        runGraphPath: (from: string, to: string) => { found: boolean; nodeIds: string[]; edgeIds: string[]; summary: string };
      }
    ).runGraphPath("concept:auth", "entity:admin");

    const server = shortestGraphPath(graph, "concept:auth", "entity:admin");
    const core = runCoreGraphPath(graph, "concept:auth", "entity:admin");

    expect(embedded.found).toBe(true);
    expect(embedded.nodeIds).toEqual(server.nodeIds);
    expect(embedded.edgeIds).toEqual(server.edgeIds);
    expect(embedded.nodeIds).toEqual(core.nodeIds);
    expect(embedded.summary).toEqual(server.summary);
  });

  it("runGraphPath resolves fuzzy labels just like the server resolver", () => {
    const graph = sampleGraph();
    const html = renderHtmlStandalone(graph);
    const { window } = loadStandaloneDom(html);

    const embedded = (
      window as unknown as {
        runGraphPath: (from: string, to: string) => { resolvedFromNodeId?: string; resolvedToNodeId?: string; found: boolean };
      }
    ).runGraphPath("Authentication", "Session");

    const server = shortestGraphPath(graph, "Authentication", "Session");
    expect(embedded.found).toBe(true);
    expect(embedded.resolvedFromNodeId).toBe("concept:auth");
    expect(embedded.resolvedToNodeId).toBe("concept:session");
    expect(embedded.resolvedFromNodeId).toBe(server.resolvedFromNodeId);
  });

  it("runGraphExplain returns the same neighborhood profile as the server explain helper", () => {
    const graph = sampleGraph();
    const html = renderHtmlStandalone(graph);
    const { window } = loadStandaloneDom(html);

    const embedded = (
      window as unknown as {
        runGraphExplain: (target: string) => {
          node: { id: string };
          neighbors: Array<{ nodeId: string; relation: string; direction: string }>;
          community?: { id: string };
          hyperedges: Array<{ id: string }>;
          summary: string;
        };
      }
    ).runGraphExplain("concept:auth");

    const server = explainGraphTarget(graph, "concept:auth");
    const core = runCoreGraphExplain(graph, "concept:auth");
    expect(core).toBeDefined();

    expect(embedded.node.id).toBe(server.node.id);
    expect(embedded.community?.id).toBe(server.community?.id);
    expect(embedded.hyperedges.map((h) => h.id)).toEqual(server.hyperedges.map((h) => h.id));
    expect(embedded.neighbors.map((n) => `${n.direction}:${n.nodeId}:${n.relation}`)).toEqual(
      server.neighbors.map((n) => `${n.direction}:${n.nodeId}:${n.relation}`)
    );
    expect(embedded.summary).toBe(server.summary);
  });

  it("renders path results into the DOM when the user triggers the Find button", () => {
    const graph = sampleGraph();
    const html = renderHtmlStandalone(graph);
    const { window } = loadStandaloneDom(html);
    const doc = window.document;

    (doc.getElementById("pathFrom") as HTMLInputElement).value = "concept:auth";
    (doc.getElementById("pathTo") as HTMLInputElement).value = "entity:admin";
    (doc.getElementById("pathFind") as HTMLButtonElement).click();

    const host = doc.getElementById("pathResult") as HTMLElement;
    expect(host.textContent).toContain("Authentication");
    expect(host.textContent).toContain("Administrator");
  });
});
