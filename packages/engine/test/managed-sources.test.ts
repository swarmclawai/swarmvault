import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import {
  addManagedSource,
  deleteManagedSource,
  ingestDirectory,
  ingestInput,
  initVault,
  listManagedSourceRecords,
  reloadManagedSources
} from "../src/index.js";
import type { ManagedSourceRecord, SourceManifest } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-managed-sources-"));
  tempDirs.push(dir);
  return dir;
}

async function readManifests(rootDir: string): Promise<SourceManifest[]> {
  const manifestsDir = path.join(rootDir, "state", "manifests");
  const entries = await fs.readdir(manifestsDir).catch(() => []);
  return await Promise.all(
    entries.map(async (entry) => JSON.parse(await fs.readFile(path.join(manifestsDir, entry), "utf8")) as SourceManifest)
  );
}

async function withPrivateUrlAllowance<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SWARMVAULT_ALLOW_PRIVATE_URLS;
  process.env.SWARMVAULT_ALLOW_PRIVATE_URLS = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SWARMVAULT_ALLOW_PRIVATE_URLS;
    } else {
      process.env.SWARMVAULT_ALLOW_PRIVATE_URLS = previous;
    }
  }
}

async function startFixtureServer(
  routes: Record<string, { contentType?: string; body: string }>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const requestUrl = request.url ? new URL(request.url, "http://127.0.0.1") : null;
    const route = requestUrl ? routes[requestUrl.pathname] : undefined;
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    const body = Buffer.from(route.body, "utf8");
    response.writeHead(200, {
      "content-type": route.contentType ?? "text/html; charset=utf-8",
      "content-length": String(body.length)
    });
    response.end(body);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind fixture server"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("managed sources", () => {
  it("backfills legacy tracked directories into the managed source registry", async () => {
    const rootDir = await createTempWorkspace();
    const repoDir = path.join(rootDir, "legacy-repo");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "README.md"), "# Legacy\n\nBackfill me.\n", "utf8");
    await fs.writeFile(path.join(repoDir, "notes.md"), "# Notes\n\nStill tracked.\n", "utf8");

    await initVault(rootDir);
    await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });

    const sources = await listManagedSourceRecords(rootDir);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("directory");
    expect(path.resolve(sources[0]?.path ?? "")).toBe(repoDir);
  });

  it("does not backfill a managed repo root from a single file ingest inside a parent git repo", async () => {
    const hostRoot = await createTempWorkspace();
    const rootDir = path.join(hostRoot, "workspace");
    await fs.mkdir(path.join(hostRoot, ".git"), { recursive: true });
    await fs.mkdir(rootDir, { recursive: true });
    const filePath = path.join(hostRoot, "notes.md");
    await fs.writeFile(filePath, "# One file\n\nThis should stay a one-off ingest.\n", "utf8");

    await initVault(rootDir);
    await ingestInput(rootDir, filePath);

    const sources = await listManagedSourceRecords(rootDir);
    expect(sources).toHaveLength(0);
  });

  it("registers, reloads, and deletes managed directory sources while preserving canonical content", async () => {
    const rootDir = await createTempWorkspace();
    const repoDir = path.join(rootDir, "apps", "alpha");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "README.md"), "# Alpha\n\nInitial source.\n", "utf8");
    await fs.writeFile(path.join(repoDir, "notes.md"), "# Notes\n\nExtra detail.\n", "utf8");

    await initVault(rootDir);
    const added = await addManagedSource(rootDir, repoDir);
    expect(added.source.kind).toBe("directory");
    expect(added.compile?.sourceCount ?? 0).toBeGreaterThan(0);
    expect(added.briefGenerated).toBe(true);
    await fs.access(added.source.briefPath ?? "");
    const brief = matter(await fs.readFile(added.source.briefPath ?? "", "utf8"));
    expect(brief.data.origin).toBe("source_brief");

    await fs.rm(path.join(repoDir, "notes.md"));
    await fs.writeFile(path.join(repoDir, "guide.md"), "# Guide\n\nReplacement detail.\n", "utf8");
    const reloaded = await reloadManagedSources(rootDir, { id: added.source.id });
    expect(reloaded.sources).toHaveLength(1);
    expect(reloaded.sources[0]?.lastSyncCounts?.removedCount ?? 0).toBeGreaterThanOrEqual(1);

    const manifests = await readManifests(rootDir);
    expect(manifests.some((manifest) => manifest.originalPath?.endsWith("guide.md"))).toBe(true);
    expect(manifests.some((manifest) => manifest.originalPath?.endsWith("notes.md"))).toBe(false);

    const deleted = await deleteManagedSource(rootDir, added.source.id);
    expect(deleted.removed.id).toBe(added.source.id);
    expect(await listManagedSourceRecords(rootDir)).toHaveLength(0);
    expect((await readManifests(rootDir)).length).toBeGreaterThan(0);
    await fs.access(path.join(rootDir, "raw"));
    await fs.access(path.join(rootDir, "wiki"));
  });

  it("clears stale sync counts when a managed file source goes missing", async () => {
    const rootDir = await createTempWorkspace();
    const filePath = path.join(rootDir, "call.srt");
    await fs.writeFile(filePath, ["1", "00:00:01,000 --> 00:00:02,000", "Managed file source.", ""].join("\n"), "utf8");

    await initVault(rootDir);
    const added = await addManagedSource(rootDir, filePath);
    expect(added.source.kind).toBe("file");
    expect(added.source.lastSyncCounts?.importedCount).toBe(1);

    await fs.rm(filePath);
    const reloaded = await reloadManagedSources(rootDir, { id: added.source.id });
    const missing = reloaded.sources[0];
    expect(missing?.status).toBe("missing");
    expect(missing?.lastSyncStatus).toBe("error");
    expect(missing?.lastSyncCounts).toEqual({
      scannedCount: 0,
      importedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      skippedCount: 0
    });
    expect(missing?.lastError).toContain("File not found");
  });

  it("does not inherit a parent repo root outside the vault for in-vault managed directories", async () => {
    const hostRoot = await createTempWorkspace();
    const rootDir = path.join(hostRoot, "workspace");
    const repoDir = path.join(rootDir, "managed", "repo");
    await fs.mkdir(path.join(hostRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(hostRoot, ".gitignore"), "workspace/managed/\n", "utf8");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "README.md"), "# Nested Repo\n\nThis source should still ingest.\n", "utf8");

    await initVault(rootDir);
    const added = await addManagedSource(rootDir, repoDir);
    expect(added.source.kind).toBe("directory");
    expect(added.source.repoRoot).toBe(repoDir);
    expect(added.source.sourceIds.length).toBeGreaterThan(0);

    const manifests = await readManifests(rootDir);
    expect(manifests.some((manifest) => manifest.originalPath?.endsWith("README.md"))).toBe(true);
  });

  it("crawls docs hubs, prunes removed pages on reload, and rejects article-style URLs", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const routes: Record<string, { contentType?: string; body: string }> = {
      "/docs/index.html": {
        body: [
          "<html><head><title>Tiny Docs</title></head><body>",
          "<nav>",
          '<a href="/docs/getting-started.html">Getting Started</a>',
          '<a href="/docs/api.html">API</a>',
          '<a href="/docs/reference.html">Reference</a>',
          "</nav>",
          "<main><h1>Tiny Docs</h1><p>Docs hub.</p></main>",
          "</body></html>"
        ].join("")
      },
      "/docs/getting-started.html": {
        body: [
          "<html><head><title>Getting Started</title></head><body>",
          '<nav><a href="/docs/index.html">Home</a><a href="/docs/api.html">API</a></nav>',
          "<main><h1>Getting Started</h1><p>Start here.</p></main>",
          "</body></html>"
        ].join("")
      },
      "/docs/api.html": {
        body: [
          "<html><head><title>API</title></head><body>",
          '<nav><a href="/docs/index.html">Home</a><a href="/docs/reference.html">Reference</a></nav>',
          "<main><h1>API</h1><p>API details.</p></main>",
          "</body></html>"
        ].join("")
      },
      "/docs/reference.html": {
        body: [
          "<html><head><title>Reference</title></head><body>",
          '<nav><a href="/docs/index.html">Home</a></nav>',
          "<main><h1>Reference</h1><p>Reference details.</p></main>",
          "</body></html>"
        ].join("")
      },
      "/blog/post.html": {
        body: "<html><head><title>One Post</title></head><body><article><h1>Article</h1><p>Not a docs hub.</p></article></body></html>"
      }
    };
    const server = await startFixtureServer(routes);
    try {
      const added = await withPrivateUrlAllowance(
        async () => await addManagedSource(rootDir, `${server.baseUrl}/docs/index.html`, { maxPages: 6, maxDepth: 2 })
      );
      expect(added.source.kind).toBe("crawl_url");
      expect(added.source.sourceIds.length).toBeGreaterThanOrEqual(3);
      expect(added.briefGenerated).toBe(true);

      routes["/docs/index.html"] = {
        body: [
          "<html><head><title>Tiny Docs</title></head><body>",
          "<nav>",
          '<a href="/docs/getting-started.html">Getting Started</a>',
          '<a href="/docs/reference.html">Reference</a>',
          '<a href="/docs/index.html">Home</a>',
          "</nav>",
          "<main><h1>Tiny Docs</h1><p>Docs hub updated.</p></main>",
          "</body></html>"
        ].join("")
      };
      routes["/docs/getting-started.html"] = {
        body: [
          "<html><head><title>Getting Started</title></head><body>",
          '<nav><a href="/docs/index.html">Home</a><a href="/docs/reference.html">Reference</a></nav>',
          "<main><h1>Getting Started</h1><p>Start here.</p></main>",
          "</body></html>"
        ].join("")
      };
      delete routes["/docs/api.html"];

      const reloaded = await withPrivateUrlAllowance(
        async () => await reloadManagedSources(rootDir, { id: added.source.id, maxPages: 6, maxDepth: 2 })
      );
      const reloadedSource = reloaded.sources[0] as ManagedSourceRecord;
      expect(reloadedSource.lastSyncCounts?.removedCount ?? 0).toBeGreaterThanOrEqual(1);
      const manifests = await readManifests(rootDir);
      expect(manifests.some((manifest) => manifest.url?.endsWith("/docs/api.html"))).toBe(false);

      await expect(
        withPrivateUrlAllowance(async () => await addManagedSource(rootDir, `${server.baseUrl}/blog/post.html`))
      ).rejects.toThrow(/docs hub|swarmvault add/i);
    } finally {
      await server.close();
    }
  });
});
