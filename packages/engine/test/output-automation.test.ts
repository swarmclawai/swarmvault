import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, ingestInput, initVault, listApprovals, listSchedules, queryVault, readApproval, runSchedule } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-output-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("output artifacts and automation", () => {
  it("writes chart and image output wrapper pages with local assets", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "artifact.md"),
      ["# Artifact", "", "Durable outputs should keep local charts and images beside the wrapper markdown page."].join("\n"),
      "utf8"
    );
    await ingestInput(rootDir, "artifact.md");
    await compileVault(rootDir);

    const chart = await queryVault(rootDir, { question: "Show the vault context as a chart", format: "chart" });
    const chartPage = matter(await fs.readFile(chart.savedPath as string, "utf8"));
    expect(chartPage.data.output_format).toBe("chart");
    expect(Array.isArray(chart.outputAssets)).toBe(true);
    expect(chart.outputAssets.some((asset) => asset.role === "primary")).toBe(true);
    await expect(
      fs.access(path.join(rootDir, "wiki", "outputs", "assets", "show-the-vault-context-as-a-chart", "primary.svg"))
    ).resolves.toBeUndefined();
    expect(chartPage.content).toContain("## Assets");
    expect(chartPage.content).toContain("![");

    const image = await queryVault(rootDir, { question: "Show the vault context as an image", format: "image" });
    const imagePage = matter(await fs.readFile(image.savedPath as string, "utf8"));
    expect(imagePage.data.output_format).toBe("image");
    expect(image.outputAssets.some((asset) => asset.role === "primary")).toBe(true);
    await expect(
      fs.access(path.join(rootDir, "wiki", "outputs", "assets", "show-the-vault-context-as-an-image", "primary.svg"))
    ).resolves.toBeUndefined();
    expect(imagePage.content).toContain("## Assets");
  });

  it("runs scheduled query jobs through review staging and records schedule state", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "schedule.md"), "# Schedule\n\nScheduled jobs should stage chart outputs for review.", "utf8");
    await ingestInput(rootDir, "schedule.md");
    await compileVault(rootDir);

    const configPath = path.join(rootDir, "swarmvault.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      schedules?: Record<string, unknown>;
    };
    config.schedules = {
      "nightly-chart": {
        enabled: true,
        when: { every: "1h" },
        task: {
          type: "query",
          question: "Show the scheduled vault context as a chart",
          format: "chart"
        }
      }
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const schedules = await listSchedules(rootDir);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.jobId).toBe("nightly-chart");

    const run = await runSchedule(rootDir, "nightly-chart");
    expect(run.success).toBe(true);
    expect(run.approvalId).toBeTruthy();

    const approvals = await listApprovals(rootDir);
    expect(approvals.some((approval) => approval.approvalId === run.approvalId)).toBe(true);

    const detail = await readApproval(rootDir, run.approvalId as string);
    expect(detail.entries.some((entry) => entry.kind === "output")).toBe(true);
    await expect(fs.access(path.join(rootDir, "wiki", "outputs", "show-the-scheduled-vault-context-as-a-chart.md"))).rejects.toThrow();

    const updatedSchedules = await listSchedules(rootDir);
    expect(updatedSchedules[0]?.lastApprovalId).toBe(run.approvalId);
    expect(updatedSchedules[0]?.lastStatus).toBe("success");
  });

  it("stages compile post-pass proposals through approvals", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "compile.md"), "# Compile\n\nCompile post-pass should stage markdown proposals.", "utf8");
    await ingestInput(rootDir, "compile.md");

    await fs.writeFile(
      path.join(rootDir, "orchestrator-provider.mjs"),
      [
        "export async function createAdapter(id, config) {",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['chat', 'structured']),",
        "    async generateText() { return { text: 'ok' }; },",
        "    async generateStructured(request) {",
        "      if (request.prompt.includes('Compile post-pass')) {",
        "        return {",
        "          findings: [],",
        "          questions: [],",
        "          proposals: [",
        "            {",
        "              path: 'concepts/post-pass-review.md',",
        "              content: '# Post Pass Review\\n\\nStaged from orchestration.',",
        "              reason: 'Add a review note after compile.'",
        "            }",
        "          ]",
        "        };",
        "      }",
        "      return { findings: [], questions: [], proposals: [] };",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );

    const configPath = path.join(rootDir, "swarmvault.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      providers: Record<string, unknown>;
      orchestration?: unknown;
    };
    config.providers.orch = {
      type: "custom",
      model: "orch-test",
      module: "./orchestrator-provider.mjs",
      capabilities: ["chat", "structured"]
    };
    config.orchestration = {
      compilePostPass: true,
      roles: {
        context: { executor: { type: "provider", provider: "orch" } }
      }
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = await compileVault(rootDir);
    expect(result.postPassApprovalId).toBeTruthy();
    await expect(fs.access(path.join(rootDir, "wiki", "concepts", "post-pass-review.md"))).rejects.toThrow();

    const detail = await readApproval(rootDir, result.postPassApprovalId as string);
    expect(detail.entries.some((entry) => entry.nextPath === "concepts/post-pass-review.md")).toBe(true);
  });
});
