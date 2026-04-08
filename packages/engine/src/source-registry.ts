import fs from "node:fs/promises";
import path from "node:path";
import { initWorkspace } from "./config.js";
import type { ManagedSourceRecord, ManagedSourcesArtifact, ResolvedPaths, SourceManifest } from "./types.js";
import { fileExists, readJsonFile, sha256, slugify, writeJsonFile } from "./utils.js";

const MANAGED_SOURCES_VERSION = 1;

function repoRootFromManifest(manifest: SourceManifest): string | null {
  if (manifest.originType !== "file" || !manifest.originalPath || !manifest.repoRelativePath) {
    return null;
  }

  const repoDir = path.posix.dirname(manifest.repoRelativePath);
  const fileDir = path.dirname(path.resolve(manifest.originalPath));
  if (repoDir === "." || !repoDir) {
    return fileDir;
  }

  const segments = repoDir.split("/").filter(Boolean);
  return path.resolve(fileDir, ...segments.map(() => ".."));
}

async function loadManifestArtifacts(paths: ResolvedPaths): Promise<SourceManifest[]> {
  const entries = await fs.readdir(paths.manifestsDir, { withFileTypes: true }).catch(() => []);
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => await readJsonFile<SourceManifest>(path.join(paths.manifestsDir, entry.name)))
  );
  return manifests.filter((manifest): manifest is SourceManifest => Boolean(manifest?.sourceId));
}

function buildLegacyDirectoryEntry(repoRoot: string, manifests: SourceManifest[]): ManagedSourceRecord {
  const repoTitle = path.basename(repoRoot) || repoRoot;
  const sourceIds = manifests.map((manifest) => manifest.sourceId).sort((left, right) => left.localeCompare(right));
  const createdAt =
    manifests.map((manifest) => manifest.createdAt).sort((left, right) => left.localeCompare(right))[0] ?? new Date().toISOString();
  const updatedAt = manifests.map((manifest) => manifest.updatedAt).sort((left, right) => right.localeCompare(left))[0] ?? createdAt;
  return {
    id: `directory-${slugify(repoTitle)}-${sha256(repoRoot).slice(0, 8)}`,
    kind: "directory",
    title: repoTitle,
    path: repoRoot,
    repoRoot,
    createdAt,
    updatedAt,
    status: "ready",
    sourceIds,
    lastSyncAt: updatedAt,
    lastSyncStatus: "success",
    lastSyncCounts: {
      scannedCount: manifests.length,
      importedCount: manifests.length,
      updatedCount: 0,
      removedCount: 0,
      skippedCount: 0
    }
  };
}

async function buildLegacyArtifact(paths: ResolvedPaths): Promise<ManagedSourcesArtifact> {
  const manifests = await loadManifestArtifacts(paths);
  const manifestsByRepoRoot = new Map<string, SourceManifest[]>();
  for (const manifest of manifests) {
    const repoRoot = repoRootFromManifest(manifest);
    if (!repoRoot) {
      continue;
    }
    const key = path.resolve(repoRoot);
    const bucket = manifestsByRepoRoot.get(key) ?? [];
    bucket.push(manifest);
    manifestsByRepoRoot.set(key, bucket);
  }
  const repoRoots = [...manifestsByRepoRoot.entries()].filter(([, repoManifests]) => {
    return repoManifests.length > 1 || repoManifests.some((manifest) => manifest.sourceKind === "code");
  });

  return {
    version: MANAGED_SOURCES_VERSION,
    sources: repoRoots
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([repoRoot, repoManifests]) => buildLegacyDirectoryEntry(repoRoot, repoManifests))
  };
}

export async function ensureManagedSourcesArtifact(rootDir: string): Promise<ManagedSourcesArtifact> {
  const { paths } = await initWorkspace(rootDir);
  if (await fileExists(paths.managedSourcesPath)) {
    const existing = await readJsonFile<ManagedSourcesArtifact>(paths.managedSourcesPath);
    if (existing?.version === MANAGED_SOURCES_VERSION && Array.isArray(existing.sources)) {
      return {
        version: MANAGED_SOURCES_VERSION,
        sources: [...existing.sources].sort(
          (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
        )
      };
    }
  }

  const artifact = await buildLegacyArtifact(paths);
  await writeJsonFile(paths.managedSourcesPath, artifact);
  return artifact;
}

export async function loadManagedSources(rootDir: string): Promise<ManagedSourceRecord[]> {
  const artifact = await ensureManagedSourcesArtifact(rootDir);
  return artifact.sources;
}

export async function readManagedSourcesIfPresent(rootDir: string): Promise<ManagedSourceRecord[] | null> {
  const { paths } = await initWorkspace(rootDir);
  if (!(await fileExists(paths.managedSourcesPath))) {
    return null;
  }
  const existing = await readJsonFile<ManagedSourcesArtifact>(paths.managedSourcesPath);
  if (!existing?.version || !Array.isArray(existing.sources)) {
    return null;
  }
  return existing.sources;
}

export async function saveManagedSources(rootDir: string, sources: ManagedSourceRecord[]): Promise<void> {
  const { paths } = await initWorkspace(rootDir);
  await writeJsonFile(paths.managedSourcesPath, {
    version: MANAGED_SOURCES_VERSION,
    sources: [...sources].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  } satisfies ManagedSourcesArtifact);
}

export async function managedSourceWorkingDir(rootDir: string, sourceId: string): Promise<string> {
  const { paths } = await initWorkspace(rootDir);
  return path.join(paths.managedSourcesDir, sourceId);
}
