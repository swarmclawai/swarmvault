import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestDirectory, initVault } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-ignore-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe(".swarmvaultignore", () => {
  it("applies parent ignore rules to subdirectory ingest without crossing the repo boundary", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    const srcDir = path.join(repoDir, "src");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, ".swarmvaultignore"), ["skip.md", "generated/**", "!generated/keep.md"].join("\n"), "utf8");
    await fs.writeFile(path.join(srcDir, "keep.md"), "# Keep\n", "utf8");
    await fs.writeFile(path.join(srcDir, "skip.md"), "# Skip\n", "utf8");
    await fs.mkdir(path.join(srcDir, "generated"), { recursive: true });
    await fs.writeFile(path.join(srcDir, "generated", "drop.md"), "# Drop\n", "utf8");
    await fs.writeFile(path.join(srcDir, "generated", "keep.md"), "# Generated Keep\n", "utf8");

    const result = await ingestDirectory(rootDir, srcDir);

    expect(result.imported.map((manifest) => manifest.title).sort()).toEqual(["Generated Keep", "Keep"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "repo/src/skip.md", reason: "swarmvaultignore" }),
        expect.objectContaining({ path: "repo/src/generated/drop.md", reason: "swarmvaultignore" })
      ])
    );
  });

  it("applies nested .swarmvaultignore files only to their subtree", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    const inputDir = path.join(repoDir, "src");
    await fs.mkdir(path.join(inputDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(inputDir, "nested", ".swarmvaultignore"), "drop.md\n", "utf8");
    await fs.writeFile(path.join(inputDir, "nested", "drop.md"), "# Drop\n", "utf8");
    await fs.writeFile(path.join(inputDir, "drop.md"), "# Keep Outer Drop Name\n", "utf8");
    await fs.writeFile(path.join(inputDir, "nested", "keep.md"), "# Keep Nested\n", "utf8");

    const result = await ingestDirectory(rootDir, inputDir, { repoRoot: repoDir });

    const titles = result.imported.map((manifest) => manifest.title).sort();
    expect(titles).toEqual(["Keep Nested", "Keep Outer Drop Name"]);
    expect(result.skipped.find((entry) => entry.path.endsWith("nested/drop.md"))?.reason).toBe("swarmvaultignore");
  });

  it("can be disabled per ingest run", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const inputDir = path.join(rootDir, "input");
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, ".swarmvaultignore"), "skip.md\n", "utf8");
    await fs.writeFile(path.join(inputDir, "skip.md"), "# Skip but ingest\n", "utf8");

    const result = await ingestDirectory(rootDir, inputDir, { swarmvaultignore: false });

    expect(result.imported.some((manifest) => manifest.title === "Skip but ingest")).toBe(true);
  });

  it("applies nested .gitignore files while .swarmvaultinclude can allowlist specific files", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    const inputDir = path.join(repoDir, "src");
    await fs.mkdir(path.join(inputDir, "generated"), { recursive: true });
    await fs.mkdir(path.join(inputDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(repoDir, ".gitignore"), "root-skip.md\ngenerated/\n", "utf8");
    await fs.writeFile(path.join(inputDir, "nested", ".gitignore"), "drop.md\n", "utf8");
    await fs.writeFile(path.join(inputDir, ".swarmvaultinclude"), "generated/keep.md\n", "utf8");
    await fs.writeFile(path.join(inputDir, "keep.md"), "# Keep\n", "utf8");
    await fs.writeFile(path.join(inputDir, "root-skip.md"), "# Root Skip\n", "utf8");
    await fs.writeFile(path.join(inputDir, "generated", "keep.md"), "# Included Generated\n", "utf8");
    await fs.writeFile(path.join(inputDir, "generated", "drop.md"), "# Dropped Generated\n", "utf8");
    await fs.writeFile(path.join(inputDir, "nested", "drop.md"), "# Nested Drop\n", "utf8");
    await fs.writeFile(path.join(inputDir, "nested", "keep.md"), "# Nested Keep\n", "utf8");

    const result = await ingestDirectory(rootDir, inputDir, { repoRoot: repoDir });

    expect(result.imported.map((manifest) => manifest.title).sort()).toEqual([".gitignore", "Included Generated", "Keep", "Nested Keep"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "repo/src/root-skip.md", reason: "gitignore" }),
        expect.objectContaining({ path: "repo/src/generated/drop.md", reason: "gitignore" }),
        expect.objectContaining({ path: "repo/src/nested/drop.md", reason: "gitignore" }),
        expect.objectContaining({ path: "repo/src/.swarmvaultinclude", reason: "swarmvaultinclude" })
      ])
    );
  });

  it("does not let .swarmvaultinclude bypass hard repository ignores", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(repoDir, ".swarmvaultinclude"), ".git/config\n", "utf8");
    await fs.writeFile(path.join(repoDir, ".git", "config"), "# Ignored\n", "utf8");

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });

    expect(result.imported.some((manifest) => manifest.originalPath?.endsWith(".git/config"))).toBe(false);
    expect(result.skipped.some((entry) => entry.path === "repo/.git" && entry.reason === "built_in_ignore:.git")).toBe(true);
  });
});
