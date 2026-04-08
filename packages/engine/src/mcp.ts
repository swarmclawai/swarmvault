import fs from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadVaultConfig } from "./config.js";
import { ingestInput, listManifests } from "./ingest.js";
import { loadVaultSchema } from "./schema.js";
import type { GraphArtifact } from "./types.js";
import { fileExists, listFilesRecursive, readJsonFile, toPosix } from "./utils.js";
import {
  compileVault,
  explainGraphVault,
  getWorkspaceInfo,
  lintVault,
  listGodNodes,
  listGraphHyperedges,
  listPages,
  pathGraphVault,
  queryGraphVault,
  queryVault,
  readGraphReport,
  readPage,
  searchVault
} from "./vault.js";

const SERVER_VERSION = "0.1.32";

export async function createMcpServer(rootDir: string): Promise<McpServer> {
  const server = new McpServer({
    name: "swarmvault",
    version: SERVER_VERSION,
    websiteUrl: "https://www.swarmvault.ai"
  });

  server.registerTool(
    "workspace_info",
    {
      description: "Return the current SwarmVault workspace paths and high-level counts."
    },
    async () => {
      const info = await getWorkspaceInfo(rootDir);
      return asToolText(info);
    }
  );

  server.registerTool(
    "search_pages",
    {
      description: "Search compiled wiki pages using the local full-text index.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(25).optional().describe("Maximum number of results")
      }
    },
    async ({ query, limit }) => {
      const results = await searchVault(rootDir, query, limit ?? 5);
      return asToolText(results);
    }
  );

  server.registerTool(
    "read_page",
    {
      description: "Read a generated wiki page by its path relative to wiki/.",
      inputSchema: {
        path: z.string().min(1).describe("Path relative to wiki/, for example sources/example.md")
      }
    },
    async ({ path: relativePath }) => {
      const page = await readPage(rootDir, relativePath);
      if (!page) {
        return asToolError(`Page not found: ${relativePath}`);
      }

      return asToolText(page);
    }
  );

  server.registerTool(
    "list_sources",
    {
      description: "List source manifests in the current workspace.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of manifests to return")
      }
    },
    async ({ limit }) => {
      const manifests = await listManifests(rootDir);
      return asToolText(limit ? manifests.slice(0, limit) : manifests);
    }
  );

  server.registerTool(
    "query_graph",
    {
      description: "Traverse the local graph from search seeds without calling a model provider.",
      inputSchema: {
        question: z.string().min(1).describe("Question or graph search seed"),
        traversal: z.enum(["bfs", "dfs"]).optional().describe("Traversal strategy"),
        budget: z.number().int().min(3).max(50).optional().describe("Maximum nodes to summarize")
      }
    },
    async ({ question, traversal, budget }) => {
      const result = await queryGraphVault(rootDir, question, {
        traversal,
        budget
      });
      return asToolText(result);
    }
  );

  server.registerTool(
    "graph_report",
    {
      description: "Return the machine-readable graph report and trust artifact."
    },
    async () => {
      return asToolText((await readGraphReport(rootDir)) ?? { error: "Graph report not found. Run `swarmvault compile` first." });
    }
  );

  server.registerTool(
    "get_node",
    {
      description: "Explain a graph node, its page, community, neighbors, and group patterns.",
      inputSchema: {
        target: z.string().min(1).describe("Node or page label/id")
      }
    },
    async ({ target }) => {
      return asToolText(await explainGraphVault(rootDir, target));
    }
  );

  server.registerTool(
    "get_hyperedges",
    {
      description: "List graph hyperedges, optionally filtered to a node or page target.",
      inputSchema: {
        target: z.string().optional().describe("Optional node/page label or id to filter by"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum hyperedges to return")
      }
    },
    async ({ target, limit }) => {
      return asToolText(await listGraphHyperedges(rootDir, target, limit ?? 25));
    }
  );

  server.registerTool(
    "get_neighbors",
    {
      description: "Return the neighbors of a graph node or page target.",
      inputSchema: {
        target: z.string().min(1).describe("Node or page label/id")
      }
    },
    async ({ target }) => {
      const explanation = await explainGraphVault(rootDir, target);
      return asToolText(explanation.neighbors);
    }
  );

  server.registerTool(
    "shortest_path",
    {
      description: "Find the shortest graph path between two targets.",
      inputSchema: {
        from: z.string().min(1).describe("Start node/page label or id"),
        to: z.string().min(1).describe("End node/page label or id")
      }
    },
    async ({ from, to }) => {
      return asToolText(await pathGraphVault(rootDir, from, to));
    }
  );

  server.registerTool(
    "god_nodes",
    {
      description: "List the highest-connectivity graph nodes.",
      inputSchema: {
        limit: z.number().int().min(1).max(25).optional().describe("Maximum nodes to return")
      }
    },
    async ({ limit }) => {
      return asToolText(await listGodNodes(rootDir, limit ?? 10));
    }
  );

  server.registerTool(
    "query_vault",
    {
      description: "Ask a question against the compiled vault and optionally save the answer.",
      inputSchema: {
        question: z.string().min(1).describe("Question to ask the vault"),
        save: z.boolean().optional().describe("Persist the answer to wiki/outputs"),
        format: z.enum(["markdown", "report", "slides", "chart", "image"]).optional().describe("Output format")
      }
    },
    async ({ question, save, format }) => {
      const result = await queryVault(rootDir, {
        question,
        save: save ?? true,
        format
      });
      return asToolText(result);
    }
  );

  server.registerTool(
    "ingest_input",
    {
      description: "Ingest a local file path or URL into the SwarmVault workspace.",
      inputSchema: {
        input: z.string().min(1).describe("Local path or URL to ingest")
      }
    },
    async ({ input }) => {
      const manifest = await ingestInput(rootDir, input);
      return asToolText(manifest);
    }
  );

  server.registerTool(
    "compile_vault",
    {
      description: "Compile source manifests into wiki pages, graph data, and search index.",
      inputSchema: {
        approve: z.boolean().optional().describe("Stage a review bundle without applying active page changes")
      }
    },
    async ({ approve }) => {
      const result = await compileVault(rootDir, { approve: approve ?? false });
      return asToolText(result);
    }
  );

  server.registerTool(
    "lint_vault",
    {
      description: "Run anti-drift and vault health checks."
    },
    async () => {
      const findings = await lintVault(rootDir);
      return asToolText(findings);
    }
  );

  server.registerResource(
    "swarmvault-config",
    "swarmvault://config",
    {
      title: "SwarmVault Config",
      description: "The resolved SwarmVault config file.",
      mimeType: "application/json"
    },
    async () => {
      const { config } = await loadVaultConfig(rootDir);
      return asTextResource("swarmvault://config", JSON.stringify(config, null, 2));
    }
  );

  server.registerResource(
    "swarmvault-graph",
    "swarmvault://graph",
    {
      title: "SwarmVault Graph",
      description: "The compiled graph artifact for the current workspace.",
      mimeType: "application/json"
    },
    async () => {
      const { paths } = await loadVaultConfig(rootDir);
      const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
      return asTextResource(
        "swarmvault://graph",
        JSON.stringify(graph ?? { error: "Graph artifact not found. Run `swarmvault compile` first." }, null, 2)
      );
    }
  );

  server.registerResource(
    "swarmvault-manifests",
    "swarmvault://manifests",
    {
      title: "SwarmVault Manifests",
      description: "All source manifests in the workspace.",
      mimeType: "application/json"
    },
    async () => {
      const manifests = await listManifests(rootDir);
      return asTextResource("swarmvault://manifests", JSON.stringify(manifests, null, 2));
    }
  );

  server.registerResource(
    "swarmvault-schema",
    "swarmvault://schema",
    {
      title: "SwarmVault Schema",
      description: "The vault schema file that guides compile and query behavior.",
      mimeType: "text/markdown"
    },
    async () => {
      const schema = await loadVaultSchema(rootDir);
      return asTextResource("swarmvault://schema", schema.content);
    }
  );

  server.registerResource(
    "swarmvault-sessions",
    "swarmvault://sessions",
    {
      title: "SwarmVault Sessions",
      description: "Canonical session artifacts for compile, query, explore, lint, and watch runs.",
      mimeType: "application/json"
    },
    async () => {
      const { paths } = await loadVaultConfig(rootDir);
      const files = (await listFilesRecursive(paths.sessionsDir))
        .filter((filePath) => filePath.endsWith(".md"))
        .map((filePath) => toPosix(path.relative(paths.sessionsDir, filePath)))
        .sort();
      return asTextResource("swarmvault://sessions", JSON.stringify(files, null, 2));
    }
  );

  server.registerResource(
    "swarmvault-pages",
    new ResourceTemplate("swarmvault://pages/{path}", {
      list: async () => {
        const pages = await listPages(rootDir);
        return {
          resources: pages.map((page) => ({
            uri: `swarmvault://pages/${encodeURIComponent(page.path)}`,
            name: page.title,
            title: page.title,
            description: `SwarmVault ${page.kind} page`,
            mimeType: "text/markdown"
          }))
        };
      }
    }),
    {
      title: "SwarmVault Pages",
      description: "Generated wiki pages exposed as MCP resources.",
      mimeType: "text/markdown"
    },
    async (_uri, variables) => {
      const encodedPath = typeof variables.path === "string" ? variables.path : "";
      const relativePath = decodeURIComponent(encodedPath);
      const page = await readPage(rootDir, relativePath);
      if (!page) {
        return asTextResource(`swarmvault://pages/${encodedPath}`, `Page not found: ${relativePath}`);
      }

      const { paths } = await loadVaultConfig(rootDir);
      const absolutePath = path.resolve(paths.wikiDir, relativePath);
      return asTextResource(`swarmvault://pages/${encodedPath}`, await fs.readFile(absolutePath, "utf8"));
    }
  );

  server.registerResource(
    "swarmvault-session-files",
    new ResourceTemplate("swarmvault://sessions/{path}", {
      list: async () => {
        const { paths } = await loadVaultConfig(rootDir);
        const files = (await listFilesRecursive(paths.sessionsDir))
          .filter((filePath) => filePath.endsWith(".md"))
          .map((filePath) => toPosix(path.relative(paths.sessionsDir, filePath)))
          .sort();
        return {
          resources: files.map((relativePath) => ({
            uri: `swarmvault://sessions/${encodeURIComponent(relativePath)}`,
            name: path.basename(relativePath, ".md"),
            title: relativePath,
            description: "SwarmVault session artifact",
            mimeType: "text/markdown"
          }))
        };
      }
    }),
    {
      title: "SwarmVault Session Files",
      description: "Session artifacts exposed as MCP resources.",
      mimeType: "text/markdown"
    },
    async (_uri, variables) => {
      const { paths } = await loadVaultConfig(rootDir);
      const encodedPath = typeof variables.path === "string" ? variables.path : "";
      const relativePath = decodeURIComponent(encodedPath);
      const absolutePath = path.resolve(paths.sessionsDir, relativePath);
      if (!absolutePath.startsWith(paths.sessionsDir) || !(await fileExists(absolutePath))) {
        return asTextResource(`swarmvault://sessions/${encodedPath}`, `Session not found: ${relativePath}`);
      }

      return asTextResource(`swarmvault://sessions/${encodedPath}`, await fs.readFile(absolutePath, "utf8"));
    }
  );

  return server;
}

export async function startMcpServer(rootDir: string, stdin?: Readable, stdout?: Writable): Promise<{ close: () => Promise<void> }> {
  const server = await createMcpServer(rootDir);
  const transport = new StdioServerTransport(stdin, stdout);
  await server.connect(transport);
  return {
    close: async () => {
      await server.close();
    }
  };
}

function asToolText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function asToolError(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message
      }
    ]
  };
}

function asTextResource(uri: string, text: string) {
  return {
    contents: [
      {
        uri,
        text
      }
    ]
  };
}
