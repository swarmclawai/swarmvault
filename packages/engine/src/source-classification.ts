import path from "node:path";
import type { SourceClass, SourceManifest, VaultConfig } from "./types.js";

export const ALL_SOURCE_CLASSES: SourceClass[] = ["first_party", "third_party", "resource", "generated"];

const THIRD_PARTY_SEGMENTS = new Set(["node_modules", "vendor", "Pods"]);
const GENERATED_SEGMENTS = new Set(["dist", "build", ".next", "coverage", "DerivedData", "target"]);

function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
  return patterns.some(
    (pattern) => path.matchesGlob(relativePath, pattern) || path.matchesGlob(path.posix.basename(relativePath), pattern)
  );
}

export function classifyRepoPath(relativePath: string, repoAnalysis?: VaultConfig["repoAnalysis"]): SourceClass {
  const normalized = relativePath.replace(/\\/g, "/");
  const custom = repoAnalysis?.classifyGlobs;

  if (custom?.first_party?.length && matchesAnyGlob(normalized, custom.first_party)) {
    return "first_party";
  }
  for (const sourceClass of ["third_party", "resource", "generated"] as const) {
    const patterns = custom?.[sourceClass];
    if (patterns?.length && matchesAnyGlob(normalized, patterns)) {
      return sourceClass;
    }
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => THIRD_PARTY_SEGMENTS.has(segment))) {
    return "third_party";
  }
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) {
    return "generated";
  }
  if (segments.some((segment) => segment.endsWith(".xcassets") || segment.endsWith(".imageset"))) {
    return "resource";
  }

  return "first_party";
}

export function normalizeExtractClasses(repoAnalysis?: VaultConfig["repoAnalysis"], extra: SourceClass[] = []): SourceClass[] {
  const configured = repoAnalysis?.extractClasses?.length ? repoAnalysis.extractClasses : ["first_party"];
  return ALL_SOURCE_CLASSES.filter((sourceClass) => new Set([...configured, ...extra]).has(sourceClass));
}

export function aggregateSourceClass(values: Array<SourceClass | undefined>): SourceClass | undefined {
  const available = ALL_SOURCE_CLASSES.filter((sourceClass) => values.includes(sourceClass));
  if (!available.length) {
    return undefined;
  }
  if (available.includes("first_party")) {
    return "first_party";
  }
  if (available.includes("resource")) {
    return "resource";
  }
  if (available.includes("third_party")) {
    return "third_party";
  }
  return "generated";
}

export function aggregateManifestSourceClass(manifests: SourceManifest[], sourceIds: string[]): SourceClass | undefined {
  const byId = new Map(manifests.map((manifest) => [manifest.sourceId, manifest.sourceClass] as const));
  return aggregateSourceClass(sourceIds.map((sourceId) => byId.get(sourceId)));
}
