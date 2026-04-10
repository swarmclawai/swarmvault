import type { GraphArtifact, GraphReportArtifact } from "./types.js";

function htmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function nodeTypeColor(type: string): string {
  const colors: Record<string, string> = {
    source: "#f59e0b",
    module: "#fb7185",
    symbol: "#8b5cf6",
    rationale: "#14b8a6",
    concept: "#0ea5e9",
    entity: "#22c55e"
  };
  return colors[type] ?? "#94a3b8";
}

export function renderGraphReportHtml(graph: GraphArtifact, report: GraphReportArtifact | null): string {
  const nodesByType = new Map<string, number>();
  for (const node of graph.nodes) {
    nodesByType.set(node.type, (nodesByType.get(node.type) ?? 0) + 1);
  }

  const edgesByRelation = new Map<string, number>();
  for (const edge of graph.edges) {
    edgesByRelation.set(edge.relation, (edgesByRelation.get(edge.relation) ?? 0) + 1);
  }

  const pagesByKind = new Map<string, typeof graph.pages>();
  for (const page of graph.pages) {
    const list = pagesByKind.get(page.kind) ?? [];
    list.push(page);
    pagesByKind.set(page.kind, list);
  }

  const godNodes = (report?.godNodes ?? []).slice(0, 15);
  const bridgeNodes = (report?.bridgeNodes ?? []).slice(0, 10);
  const communities = graph.communities ?? [];
  const warnings = report?.warnings ?? [];
  const overview = report?.overview ?? {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    pages: graph.pages.length,
    communities: communities.length
  };

  const sortedEdgeRelations = [...edgesByRelation.entries()].sort((a, b) => b[1] - a[1]);
  const sortedNodeTypes = [...nodesByType.entries()].sort((a, b) => b[1] - a[1]);
  const sortedCommunities = [...communities].sort((a, b) => b.nodeIds.length - a.nodeIds.length).slice(0, 20);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SwarmVault Graph Report</title>
<style>
:root {
  --bg: #0f172a;
  --surface: #1e293b;
  --surface2: #334155;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #0ea5e9;
  --accent2: #8b5cf6;
  --border: #475569;
  --success: #22c55e;
  --warning: #f59e0b;
  --danger: #ef4444;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  padding: 2rem;
  max-width: 1200px;
  margin: 0 auto;
}
h1 {
  font-size: 1.75rem;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 0.25rem;
}
.subtitle { color: var(--muted); font-size: 0.85rem; margin-bottom: 2rem; }
h2 {
  font-size: 1.15rem;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.5rem;
  margin: 2rem 0 1rem;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  text-align: center;
}
.stat-card .value {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--accent);
}
.stat-card .label {
  font-size: 0.8rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 9999px;
  font-size: 0.7rem;
  font-weight: 600;
  color: #fff;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 1rem;
}
th, td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
}
th {
  color: var(--muted);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
tr:hover { background: var(--surface); }
.bar-container {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.bar {
  height: 8px;
  border-radius: 4px;
  background: var(--accent);
  min-width: 2px;
}
.warning-list {
  list-style: none;
  padding: 0;
}
.warning-list li {
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.5rem;
  background: var(--surface);
  border-left: 3px solid var(--warning);
  border-radius: 0 4px 4px 0;
  font-size: 0.85rem;
}
.page-group { margin-bottom: 1.5rem; }
.page-group-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--accent);
  text-transform: capitalize;
  margin-bottom: 0.5rem;
}
.page-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.5rem;
}
.page-item {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.page-item .path { color: var(--muted); font-size: 0.7rem; }
.empty { color: var(--muted); font-style: italic; font-size: 0.85rem; }
input[type="text"] {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 0.85rem;
  margin-bottom: 1rem;
  outline: none;
}
input[type="text"]:focus { border-color: var(--accent); }
.section { margin-bottom: 1rem; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.75rem; text-align: center; }
</style>
</head>
<body>
<h1>SwarmVault Graph Report</h1>
<p class="subtitle">Generated ${htmlEscape(report?.generatedAt ?? graph.generatedAt ?? new Date().toISOString())}</p>

<div class="stats-grid">
  <div class="stat-card"><div class="value">${overview.nodes}</div><div class="label">Nodes</div></div>
  <div class="stat-card"><div class="value">${overview.edges}</div><div class="label">Edges</div></div>
  <div class="stat-card"><div class="value">${overview.pages}</div><div class="label">Pages</div></div>
  <div class="stat-card"><div class="value">${overview.communities}</div><div class="label">Communities</div></div>
  <div class="stat-card"><div class="value">${graph.sources.length}</div><div class="label">Sources</div></div>
  <div class="stat-card"><div class="value">${(graph.hyperedges ?? []).length}</div><div class="label">Hyperedges</div></div>
</div>

<h2>Node Types</h2>
<table>
<thead><tr><th>Type</th><th>Count</th><th></th></tr></thead>
<tbody>
${sortedNodeTypes
  .map(([type, count]) => {
    const maxCount = sortedNodeTypes[0]?.[1] ?? 1;
    const pct = Math.round((count / maxCount) * 100);
    return `<tr><td><span class="badge" style="background:${nodeTypeColor(type)}">${htmlEscape(type)}</span></td><td>${count}</td><td><div class="bar-container"><div class="bar" style="width:${pct}%;background:${nodeTypeColor(type)}"></div></div></td></tr>`;
  })
  .join("\n")}
</tbody>
</table>

<h2>Edge Relations</h2>
<table>
<thead><tr><th>Relation</th><th>Count</th><th></th></tr></thead>
<tbody>
${sortedEdgeRelations
  .map(([relation, count]) => {
    const maxCount = sortedEdgeRelations[0]?.[1] ?? 1;
    const pct = Math.round((count / maxCount) * 100);
    return `<tr><td>${htmlEscape(relation)}</td><td>${count}</td><td><div class="bar-container"><div class="bar" style="width:${pct}%"></div></div></td></tr>`;
  })
  .join("\n")}
</tbody>
</table>

${
  godNodes.length
    ? `<h2>God Nodes (Highest Connectivity)</h2>
<table>
<thead><tr><th>Label</th><th>Degree</th><th>Bridge Score</th><th></th></tr></thead>
<tbody>
${godNodes
  .map((node) => {
    const maxDegree = godNodes[0]?.degree ?? 1;
    const pct = Math.round(((node.degree ?? 0) / maxDegree) * 100);
    return `<tr><td>${htmlEscape(node.label)}</td><td>${node.degree ?? 0}</td><td>${(node.bridgeScore ?? 0).toFixed(2)}</td><td><div class="bar-container"><div class="bar" style="width:${pct}%;background:var(--accent2)"></div></div></td></tr>`;
  })
  .join("\n")}
</tbody>
</table>`
    : ""
}

${
  bridgeNodes.length
    ? `<h2>Bridge Nodes</h2>
<table>
<thead><tr><th>Label</th><th>Degree</th><th>Bridge Score</th></tr></thead>
<tbody>
${bridgeNodes.map((node) => `<tr><td>${htmlEscape(node.label)}</td><td>${node.degree ?? 0}</td><td>${(node.bridgeScore ?? 0).toFixed(2)}</td></tr>`).join("\n")}
</tbody>
</table>`
    : ""
}

${
  sortedCommunities.length
    ? `<h2>Communities</h2>
<table>
<thead><tr><th>Label</th><th>Nodes</th><th></th></tr></thead>
<tbody>
${sortedCommunities
  .map((c) => {
    const maxSize = sortedCommunities[0]?.nodeIds.length ?? 1;
    const pct = Math.round((c.nodeIds.length / maxSize) * 100);
    return `<tr><td>${htmlEscape(c.label)}</td><td>${c.nodeIds.length}</td><td><div class="bar-container"><div class="bar" style="width:${pct}%;background:var(--success)"></div></div></td></tr>`;
  })
  .join("\n")}
</tbody>
</table>`
    : ""
}

${
  warnings.length
    ? `<h2>Warnings</h2>
<ul class="warning-list">
${warnings.map((w) => `<li>${htmlEscape(w)}</li>`).join("\n")}
</ul>`
    : ""
}

<h2>Pages</h2>
<input type="text" id="page-filter" placeholder="Filter pages..." />
<div id="pages-container">
${[...pagesByKind.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(
    ([kind, pages]) => `<div class="page-group" data-kind="${htmlEscape(kind)}">
  <div class="page-group-title">${htmlEscape(kind)} (${pages.length})</div>
  <div class="page-list">
    ${pages
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(
        (p) =>
          `<div class="page-item" data-title="${htmlEscape(p.title.toLowerCase())}"><strong>${htmlEscape(p.title)}</strong><div class="path">${htmlEscape(p.path)}</div></div>`
      )
      .join("\n    ")}
  </div>
</div>`
  )
  .join("\n")}
</div>

<footer>Generated by SwarmVault &middot; ${graph.nodes.length} nodes &middot; ${graph.edges.length} edges &middot; ${graph.pages.length} pages</footer>

<script>
document.getElementById("page-filter").addEventListener("input", function(e) {
  var query = e.target.value.toLowerCase();
  document.querySelectorAll(".page-item").forEach(function(el) {
    el.style.display = el.getAttribute("data-title").includes(query) ? "" : "none";
  });
  document.querySelectorAll(".page-group").forEach(function(group) {
    var visible = group.querySelectorAll('.page-item[style=""], .page-item:not([style])').length;
    group.style.display = visible > 0 || !query ? "" : "none";
  });
});
</script>
</body>
</html>`;
}
