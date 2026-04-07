import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, ingestInput, initVault, loadVaultConfig, queryVault } from "../src/index.js";
import { searchPages } from "../src/search.js";
import type { CompileState } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-projects-"));
  tempDirs.push(dir);
  return dir;
}

async function updateConfig(
  rootDir: string,
  mutate: (config: { providers: Record<string, unknown>; tasks: Record<string, string>; projects?: Record<string, unknown> }) => void
): Promise<void> {
  const configPath = path.join(rootDir, "swarmvault.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    providers: Record<string, unknown>;
    tasks: Record<string, string>;
    projects?: Record<string, unknown>;
  };
  mutate(config);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("project-aware vault organization", () => {
  it("assigns project_ids, builds project indexes, and expands obsidian defaults", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await updateConfig(rootDir, (config) => {
      config.projects = {
        alpha: {
          roots: ["apps/alpha"]
        },
        beta: {
          roots: ["apps/beta"]
        }
      };
    });
    await initVault(rootDir, { obsidian: true });

    await fs.mkdir(path.join(rootDir, "apps", "alpha"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "apps", "alpha", "alpha.md"), "# Alpha Notes\n\nAlpha systems stay local-first.", "utf8");
    await fs.writeFile(path.join(rootDir, "notes", "global.md"), "# Global Notes\n\nGlobal notes stay shared.", "utf8");

    const alphaManifest = await ingestInput(rootDir, "apps/alpha/alpha.md");
    const globalManifest = await ingestInput(rootDir, "notes/global.md");
    await compileVault(rootDir);

    const alphaSource = matter(await fs.readFile(path.join(rootDir, "wiki", "sources", `${alphaManifest.sourceId}.md`), "utf8"));
    const globalSource = matter(await fs.readFile(path.join(rootDir, "wiki", "sources", `${globalManifest.sourceId}.md`), "utf8"));
    expect(alphaSource.data.project_ids).toEqual(["alpha"]);
    expect(alphaSource.data.tags).toContain("project/alpha");
    expect(globalSource.data.project_ids).toEqual([]);

    const rootIndex = await fs.readFile(path.join(rootDir, "wiki", "index.md"), "utf8");
    const projectsIndex = await fs.readFile(path.join(rootDir, "wiki", "projects", "index.md"), "utf8");
    const alphaProjectIndex = await fs.readFile(path.join(rootDir, "wiki", "projects", "alpha", "index.md"), "utf8");
    expect(rootIndex).toContain("## Projects");
    expect(projectsIndex).toContain("projects/alpha/index");
    expect(alphaProjectIndex).toContain(`sources/${alphaManifest.sourceId}`);

    const compileState = JSON.parse(await fs.readFile(path.join(rootDir, "state", "compile-state.json"), "utf8")) as CompileState;
    expect(compileState.sourceProjects[alphaManifest.sourceId]).toBe("alpha");
    expect(compileState.sourceProjects[globalManifest.sourceId]).toBeNull();

    const graphConfig = JSON.parse(await fs.readFile(path.join(rootDir, ".obsidian", "graph.json"), "utf8")) as {
      colorGroups: Array<{ query: string }>;
    };
    const workspaceConfig = JSON.parse(await fs.readFile(path.join(rootDir, ".obsidian", "workspace.json"), "utf8")) as {
      lastOpenFiles: string[];
    };
    expect(graphConfig.colorGroups.some((group) => group.query === "tag:#project/alpha")).toBe(true);
    expect(workspaceConfig.lastOpenFiles).toEqual(
      expect.arrayContaining(["wiki/index.md", "wiki/projects/index.md", "wiki/candidates/index.md", "wiki/insights/index.md"])
    );
  });

  it("layers project schemas into compile and query work", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const rootMarker = "ROOT_RULE_MARKER";
    const alphaMarker = "ALPHA_RULE_MARKER";
    await fs.writeFile(
      path.join(rootDir, "swarmvault.schema.md"),
      ["# SwarmVault Schema", "", "## Grounding Rules", "", `- Always include ${rootMarker}.`, ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "alpha.schema.md"),
      ["# Alpha Schema", "", "## Grounding Rules", "", `- Always include ${alphaMarker}.`, ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "project-schema-provider.mjs"),
      [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "",
        "export async function createAdapter(id, config, rootDir) {",
        "  const logDir = path.join(rootDir, 'state');",
        "  async function append(name, payload) {",
        "    await fs.mkdir(logDir, { recursive: true });",
        "    await fs.appendFile(path.join(logDir, name), JSON.stringify(payload) + '\\n', 'utf8');",
        "  }",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['chat', 'structured']),",
        "    async generateText(request) {",
        "      await append('provider-text.ndjson', request);",
        "      return { text: 'Schema-layered answer.' };",
        "    },",
        "    async generateStructured(request) {",
        "      await append('provider-structured.ndjson', request);",
        "      return {",
        "        title: 'Schema Source',",
        "        summary: 'Schema summary.',",
        "        concepts: [{ name: 'Alpha', description: 'Alpha concept.' }],",
        "        entities: [],",
        "        claims: [{ text: 'Alpha claim.', confidence: 0.9, status: 'extracted', polarity: 'positive', citation: 'schema-source' }],",
        "        questions: ['What changed?']",
        "      };",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );
    await updateConfig(rootDir, (config) => {
      config.providers.projectSchema = {
        type: "custom",
        model: "project-schema-test",
        module: "./project-schema-provider.mjs",
        capabilities: ["chat", "structured"]
      };
      config.tasks.compileProvider = "projectSchema";
      config.tasks.queryProvider = "projectSchema";
      config.projects = {
        alpha: {
          roots: ["apps/alpha"],
          schemaPath: "alpha.schema.md"
        }
      };
    });

    await fs.mkdir(path.join(rootDir, "apps", "alpha"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "apps", "alpha", "alpha.md"), "# Alpha Source\n\nAlpha-specific knowledge lives here.", "utf8");
    await fs.writeFile(path.join(rootDir, "docs", "global.md"), "# Global Source\n\nGlobal knowledge lives here.", "utf8");

    const alphaManifest = await ingestInput(rootDir, "apps/alpha/alpha.md");
    await ingestInput(rootDir, "docs/global.md");
    await compileVault(rootDir);

    const compileLogs = (await fs.readFile(path.join(rootDir, "state", "provider-structured.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { prompt?: string; system?: string });
    const alphaCompileRequest = compileLogs.find((entry) => entry.prompt?.includes("Alpha Source"));
    const globalCompileRequest = compileLogs.find((entry) => entry.prompt?.includes("Global Source"));
    expect(alphaCompileRequest?.system).toContain(rootMarker);
    expect(alphaCompileRequest?.system).toContain(alphaMarker);
    expect(globalCompileRequest?.system).toContain(rootMarker);
    expect(globalCompileRequest?.system).not.toContain(alphaMarker);

    const query = await queryVault(rootDir, { question: "What does Alpha Source cover?" });
    const queryLog = await fs.readFile(path.join(rootDir, "state", "provider-text.ndjson"), "utf8");
    expect(queryLog).toContain(rootMarker);
    expect(queryLog).toContain(alphaMarker);

    const savedPage = matter(await fs.readFile(query.savedPath as string, "utf8"));
    expect(savedPage.data.project_ids).toEqual(["alpha"]);

    const sourcePage = matter(await fs.readFile(path.join(rootDir, "wiki", "sources", `${alphaManifest.sourceId}.md`), "utf8"));
    const compileState = JSON.parse(await fs.readFile(path.join(rootDir, "state", "compile-state.json"), "utf8")) as CompileState;
    expect(sourcePage.data.schema_hash).toBe(compileState.effectiveSchemaHashes.projects.alpha);
  });

  it("filters local search by project, kind, and status", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await updateConfig(rootDir, (config) => {
      config.projects = {
        alpha: {
          roots: ["apps/alpha"]
        }
      };
    });

    await fs.mkdir(path.join(rootDir, "apps", "alpha"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "apps", "alpha", "alpha.md"), "# Alpha Search\n\nAlpha search terms appear here.", "utf8");
    await fs.writeFile(
      path.join(rootDir, "notes", "global.md"),
      "# Alpha Search Global\n\nAlpha search terms also appear globally.",
      "utf8"
    );

    await ingestInput(rootDir, "apps/alpha/alpha.md");
    await ingestInput(rootDir, "notes/global.md");
    await compileVault(rootDir);

    const { paths } = await loadVaultConfig(rootDir);
    const alphaResults = searchPages(paths.searchDbPath, "Alpha", { project: "alpha", kind: "source", status: "active", limit: 10 });
    const unassignedResults = searchPages(paths.searchDbPath, "Alpha", { project: "unassigned", limit: 10 });

    expect(alphaResults.length).toBeGreaterThan(0);
    expect(alphaResults.every((result) => result.path.startsWith("sources/") && result.projectIds.includes("alpha"))).toBe(true);
    expect(unassignedResults.some((result) => result.projectIds.length === 0)).toBe(true);
  });
});
