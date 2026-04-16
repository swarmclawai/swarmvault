import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, getWebSearchAdapterForTask, ingestInput, initVault, queryVault } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-web-gap-"));
  tempDirs.push(dir);
  return dir;
}

async function writeWebSearchStub(rootDir: string, filename = "web-search-provider.mjs"): Promise<void> {
  await fs.writeFile(
    path.join(rootDir, filename),
    [
      "export async function createAdapter(id) {",
      "  return {",
      "    id,",
      "    type: 'custom',",
      "    async search(query, limit) {",
      "      return [",
      "        {",
      "          title: 'External Evidence',",
      "          url: 'https://example.com/evidence',",
      "          snippet: 'Evidence for ' + query",
      "        },",
      "        {",
      "          title: 'Secondary Source',",
      "          url: 'https://example.com/secondary',",
      "          snippet: 'Secondary snippet for ' + query",
      "        }",
      "      ].slice(0, limit ?? 5);",
      "    }",
      "  };",
      "}"
    ].join("\n"),
    "utf8"
  );
}

type RawConfig = {
  providers: Record<string, unknown>;
  tasks: Record<string, string>;
  webSearch?: {
    providers: Record<string, unknown>;
    tasks: Record<string, string>;
  };
};

async function readConfig(rootDir: string): Promise<RawConfig> {
  return JSON.parse(await fs.readFile(path.join(rootDir, "swarmvault.config.json"), "utf8")) as RawConfig;
}

async function writeConfig(rootDir: string, config: RawConfig): Promise<void> {
  await fs.writeFile(path.join(rootDir, "swarmvault.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("web search gap-fill", () => {
  it("resolves a web search adapter for the queryProvider task", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await writeWebSearchStub(rootDir);

    const config = await readConfig(rootDir);
    config.webSearch = {
      providers: {
        stub: {
          type: "custom",
          module: "./web-search-provider.mjs"
        }
      },
      tasks: {
        deepLintProvider: "stub",
        queryProvider: "stub"
      }
    };
    await writeConfig(rootDir, config);

    const adapter = await getWebSearchAdapterForTask(rootDir, "queryProvider");
    const results = await adapter.search("anything", 2);
    expect(results).toHaveLength(2);
    expect(results[0]?.url).toBe("https://example.com/evidence");
  });

  it("resolves a web search adapter for the exploreProvider task", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await writeWebSearchStub(rootDir);

    const config = await readConfig(rootDir);
    config.webSearch = {
      providers: {
        stub: {
          type: "custom",
          module: "./web-search-provider.mjs"
        }
      },
      tasks: {
        deepLintProvider: "stub",
        exploreProvider: "stub"
      }
    };
    await writeConfig(rootDir, config);

    const adapter = await getWebSearchAdapterForTask(rootDir, "exploreProvider");
    const results = await adapter.search("anything");
    expect(results[0]?.title).toBe("External Evidence");
  });

  it("merges web search results into query citations and output when gap-fill is enabled", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "note.md"),
      "# Gap Fill\n\nLocal vault note about a narrow topic that needs external evidence.",
      "utf8"
    );
    await ingestInput(rootDir, "note.md");
    await compileVault(rootDir);

    await writeWebSearchStub(rootDir);
    const config = await readConfig(rootDir);
    config.webSearch = {
      providers: {
        stub: {
          type: "custom",
          module: "./web-search-provider.mjs"
        }
      },
      tasks: {
        deepLintProvider: "stub",
        queryProvider: "stub"
      }
    };
    await writeConfig(rootDir, config);

    const result = await queryVault(rootDir, {
      question: "What external evidence supports the gap-fill topic?",
      gapFill: true
    });
    expect(result.citations).toContain("https://example.com/evidence");
    expect(result.citations).toContain("https://example.com/secondary");
    expect(result.savedPath).toBeTruthy();

    const saved = matter(await fs.readFile(result.savedPath as string, "utf8"));
    const citationList = saved.data.source_ids as string[] | undefined;
    expect(citationList).toBeDefined();
    expect(citationList).toContain("https://example.com/evidence");
  });

  it("fails fast when gap-fill is requested but no web search provider is configured", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "note.md"), "# Gap Fill\n\nLocal vault note.", "utf8");
    await ingestInput(rootDir, "note.md");
    await compileVault(rootDir);

    await expect(
      queryVault(rootDir, {
        question: "Does gap-fill fail without a provider?",
        gapFill: true,
        save: false
      })
    ).rejects.toThrow(/gap-fill/);
  });
});
