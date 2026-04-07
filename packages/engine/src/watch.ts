import path from "node:path";
import process from "node:process";
import chokidar from "chokidar";
import { initWorkspace } from "./config.js";
import { importInbox, listTrackedRepoRoots, syncTrackedReposForWatch } from "./ingest.js";
import { appendWatchRun, recordSession } from "./logs.js";
import type { WatchController, WatchOptions, WatchStatusResult } from "./types.js";
import { compileVault, lintVault } from "./vault.js";
import {
  markPagesStaleForSources,
  mergePendingSemanticRefresh,
  readPendingSemanticRefresh,
  readWatchStatusArtifact,
  writeWatchStatusArtifact
} from "./watch-state.js";

const MAX_BACKOFF_MS = 30_000;
const BACKOFF_THRESHOLD = 3;
const CRITICAL_THRESHOLD = 10;
const REPO_WATCH_IGNORES = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".venv", "vendor", "target"]);

type WatchCycleResult = {
  watchedRepoRoots: string[];
  importedCount: number;
  scannedCount: number;
  attachmentCount: number;
  repoImportedCount: number;
  repoUpdatedCount: number;
  repoRemovedCount: number;
  repoScannedCount: number;
  pendingSemanticRefreshCount: number;
  pendingSemanticRefreshPaths: string[];
  changedPages: string[];
  lintFindingCount?: number;
};

function withinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasIgnoredRepoSegment(baseDir: string, targetPath: string): boolean {
  const relativePath = path.relative(baseDir, targetPath);
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }
  return relativePath.split(path.sep).some((segment) => REPO_WATCH_IGNORES.has(segment));
}

function workspaceIgnoreRoots(rootDir: string, paths: Awaited<ReturnType<typeof initWorkspace>>["paths"]): string[] {
  return [
    paths.rawDir,
    paths.wikiDir,
    paths.stateDir,
    paths.agentDir,
    paths.inboxDir,
    path.join(rootDir, ".claude"),
    path.join(rootDir, ".cursor"),
    path.join(rootDir, ".obsidian")
  ].map((candidate) => path.resolve(candidate));
}

async function resolveWatchTargets(
  rootDir: string,
  paths: Awaited<ReturnType<typeof initWorkspace>>["paths"],
  options: WatchOptions
): Promise<string[]> {
  const targets = new Set<string>([path.resolve(paths.inboxDir)]);
  if (options.repo) {
    for (const repoRoot of await listTrackedRepoRoots(rootDir)) {
      targets.add(path.resolve(repoRoot));
    }
  }
  return [...targets].sort((left, right) => left.localeCompare(right));
}

async function performWatchCycle(
  rootDir: string,
  paths: Awaited<ReturnType<typeof initWorkspace>>["paths"],
  options: WatchOptions
): Promise<WatchCycleResult> {
  const imported = await importInbox(rootDir, paths.inboxDir);
  const repoSync = options.repo ? await syncTrackedReposForWatch(rootDir) : null;
  const compile = await compileVault(rootDir);
  const pendingSemanticRefresh = repoSync
    ? await mergePendingSemanticRefresh(rootDir, repoSync.pendingSemanticRefresh)
    : await readPendingSemanticRefresh(rootDir);
  const stalePagePaths = await markPagesStaleForSources(
    rootDir,
    pendingSemanticRefresh.map((entry) => entry.sourceId).filter((sourceId): sourceId is string => Boolean(sourceId))
  );
  const lintFindingCount = options.lint ? (await lintVault(rootDir)).length : undefined;

  return {
    watchedRepoRoots: repoSync?.repoRoots ?? [],
    importedCount: imported.imported.length,
    scannedCount: imported.scannedCount,
    attachmentCount: imported.attachmentCount,
    repoImportedCount: repoSync?.imported.length ?? 0,
    repoUpdatedCount: repoSync?.updated.length ?? 0,
    repoRemovedCount: repoSync?.removed.length ?? 0,
    repoScannedCount: repoSync?.scannedCount ?? 0,
    pendingSemanticRefreshCount: pendingSemanticRefresh.length,
    pendingSemanticRefreshPaths: pendingSemanticRefresh.map((entry) => entry.path),
    changedPages: [...new Set([...compile.changedPages, ...stalePagePaths])],
    lintFindingCount
  };
}

export async function runWatchCycle(rootDir: string, options: WatchOptions = {}): Promise<WatchCycleResult> {
  const { paths } = await initWorkspace(rootDir);
  const startedAt = new Date();
  let success = true;
  let error: string | undefined;
  let result: WatchCycleResult = {
    watchedRepoRoots: [],
    importedCount: 0,
    scannedCount: 0,
    attachmentCount: 0,
    repoImportedCount: 0,
    repoUpdatedCount: 0,
    repoRemovedCount: 0,
    repoScannedCount: 0,
    pendingSemanticRefreshCount: 0,
    pendingSemanticRefreshPaths: [],
    changedPages: []
  };

  try {
    result = await performWatchCycle(rootDir, paths, options);
    return result;
  } catch (caught) {
    success = false;
    error = caught instanceof Error ? caught.message : String(caught);
    throw caught;
  } finally {
    const finishedAt = new Date();
    await recordSession(rootDir, {
      operation: "watch",
      title: `Watch cycle for ${paths.inboxDir}${options.repo ? " and tracked repos" : ""}`,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      success,
      error,
      changedPages: result.changedPages,
      lintFindingCount: result.lintFindingCount,
      lines: [
        "reasons=once",
        `imported=${result.importedCount}`,
        `scanned=${result.scannedCount}`,
        `attachments=${result.attachmentCount}`,
        `repo_scanned=${result.repoScannedCount}`,
        `repo_imported=${result.repoImportedCount}`,
        `repo_updated=${result.repoUpdatedCount}`,
        `repo_removed=${result.repoRemovedCount}`,
        `pending_semantic_refresh=${result.pendingSemanticRefreshCount}`,
        `lint=${result.lintFindingCount ?? 0}`
      ]
    });
    await appendWatchRun(rootDir, {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      inputDir: paths.inboxDir,
      reasons: ["once"],
      importedCount: result.importedCount + result.repoImportedCount + result.repoUpdatedCount,
      scannedCount: result.scannedCount + result.repoScannedCount,
      attachmentCount: result.attachmentCount,
      changedPages: result.changedPages,
      repoImportedCount: result.repoImportedCount,
      repoUpdatedCount: result.repoUpdatedCount,
      repoRemovedCount: result.repoRemovedCount,
      repoScannedCount: result.repoScannedCount,
      pendingSemanticRefreshCount: result.pendingSemanticRefreshCount,
      pendingSemanticRefreshPaths: result.pendingSemanticRefreshPaths,
      lintFindingCount: result.lintFindingCount,
      success,
      error
    });
    await writeWatchStatusArtifact(rootDir, {
      generatedAt: finishedAt.toISOString(),
      watchedRepoRoots: result.watchedRepoRoots,
      lastRun: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        inputDir: paths.inboxDir,
        reasons: ["once"],
        importedCount: result.importedCount + result.repoImportedCount + result.repoUpdatedCount,
        scannedCount: result.scannedCount + result.repoScannedCount,
        attachmentCount: result.attachmentCount,
        changedPages: result.changedPages,
        repoImportedCount: result.repoImportedCount,
        repoUpdatedCount: result.repoUpdatedCount,
        repoRemovedCount: result.repoRemovedCount,
        repoScannedCount: result.repoScannedCount,
        pendingSemanticRefreshCount: result.pendingSemanticRefreshCount,
        pendingSemanticRefreshPaths: result.pendingSemanticRefreshPaths,
        lintFindingCount: result.lintFindingCount,
        success,
        error
      },
      pendingSemanticRefresh: await readPendingSemanticRefresh(rootDir)
    });
  }
}

export async function watchVault(rootDir: string, options: WatchOptions = {}): Promise<WatchController> {
  const { paths } = await initWorkspace(rootDir);
  const baseDebounceMs = options.debounceMs ?? 900;
  const ignoredRoots = workspaceIgnoreRoots(rootDir, paths);
  const inboxWatchRoot = path.resolve(paths.inboxDir);
  let watchTargets = await resolveWatchTargets(rootDir, paths, options);

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;
  let closed = false;
  let consecutiveFailures = 0;
  let currentDebounceMs = baseDebounceMs;
  const reasons = new Set<string>();

  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    usePolling: true,
    interval: 100,
    ignored: (targetPath) => {
      const absolutePath = path.resolve(targetPath);
      const primaryTarget =
        watchTargets.filter((watchTarget) => withinRoot(watchTarget, absolutePath)).sort((left, right) => right.length - left.length)[0] ??
        null;
      if (!primaryTarget) {
        return false;
      }
      if (primaryTarget !== inboxWatchRoot && ignoredRoots.some((ignoreRoot) => withinRoot(ignoreRoot, absolutePath))) {
        return true;
      }
      return hasIgnoredRepoSegment(primaryTarget, absolutePath);
    },
    awaitWriteFinish: {
      stabilityThreshold: Math.max(250, Math.floor(baseDebounceMs / 2)),
      pollInterval: 100
    }
  });

  const syncWatchTargets = async () => {
    const nextTargets = await resolveWatchTargets(rootDir, paths, options);
    const nextSet = new Set(nextTargets);
    const currentSet = new Set(watchTargets);

    const toRemove = watchTargets.filter((target) => !nextSet.has(target));
    const toAdd = nextTargets.filter((target) => !currentSet.has(target));

    if (toRemove.length > 0) {
      await watcher.unwatch(toRemove);
    }
    if (toAdd.length > 0) {
      await watcher.add(toAdd);
    }
    watchTargets = nextTargets;
  };

  const schedule = (reason: string) => {
    if (closed) {
      return;
    }

    reasons.add(reason);
    pending = true;
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      void runCycle();
    }, currentDebounceMs);
  };

  const runCycle = async () => {
    if (running || closed || !pending) {
      return;
    }

    pending = false;
    running = true;
    const startedAt = new Date();
    const runReasons = [...reasons];
    reasons.clear();

    let importedCount = 0;
    let scannedCount = 0;
    let attachmentCount = 0;
    let repoImportedCount = 0;
    let repoUpdatedCount = 0;
    let repoRemovedCount = 0;
    let repoScannedCount = 0;
    let watchedRepoRoots: string[] = [];
    let pendingSemanticRefreshCount = 0;
    let pendingSemanticRefreshPaths: string[] = [];
    let changedPages: string[] = [];
    let lintFindingCount: number | undefined;
    let success = true;
    let error: string | undefined;

    try {
      const result = await performWatchCycle(rootDir, paths, options);
      importedCount = result.importedCount;
      scannedCount = result.scannedCount;
      attachmentCount = result.attachmentCount;
      repoImportedCount = result.repoImportedCount;
      repoUpdatedCount = result.repoUpdatedCount;
      repoRemovedCount = result.repoRemovedCount;
      repoScannedCount = result.repoScannedCount;
      watchedRepoRoots = result.watchedRepoRoots;
      pendingSemanticRefreshCount = result.pendingSemanticRefreshCount;
      pendingSemanticRefreshPaths = result.pendingSemanticRefreshPaths;
      changedPages = result.changedPages;
      lintFindingCount = result.lintFindingCount;

      consecutiveFailures = 0;
      currentDebounceMs = baseDebounceMs;
      await syncWatchTargets();
    } catch (caught) {
      success = false;
      error = caught instanceof Error ? caught.message : String(caught);
      consecutiveFailures++;
      pending = true;

      if (consecutiveFailures >= CRITICAL_THRESHOLD) {
        process.stderr.write(
          `[swarmvault watch] ${consecutiveFailures} consecutive failures. Check vault state. Continuing at max backoff.\n`
        );
      }

      if (consecutiveFailures >= BACKOFF_THRESHOLD) {
        const multiplier = 2 ** (consecutiveFailures - BACKOFF_THRESHOLD);
        currentDebounceMs = Math.min(baseDebounceMs * multiplier, MAX_BACKOFF_MS);
      }
    } finally {
      const finishedAt = new Date();
      await recordSession(rootDir, {
        operation: "watch",
        title: `Watch cycle for ${paths.inboxDir}${options.repo ? " and tracked repos" : ""}`,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        success,
        error,
        changedPages,
        lintFindingCount,
        lines: [
          `reasons=${runReasons.join(",") || "none"}`,
          `imported=${importedCount}`,
          `scanned=${scannedCount}`,
          `attachments=${attachmentCount}`,
          `repo_scanned=${repoScannedCount}`,
          `repo_imported=${repoImportedCount}`,
          `repo_updated=${repoUpdatedCount}`,
          `repo_removed=${repoRemovedCount}`,
          `lint=${lintFindingCount ?? 0}`
        ]
      });
      await appendWatchRun(rootDir, {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        inputDir: paths.inboxDir,
        reasons: runReasons,
        importedCount: importedCount + repoImportedCount + repoUpdatedCount,
        scannedCount: scannedCount + repoScannedCount,
        attachmentCount,
        changedPages,
        repoImportedCount,
        repoUpdatedCount,
        repoRemovedCount,
        repoScannedCount,
        pendingSemanticRefreshCount,
        pendingSemanticRefreshPaths,
        lintFindingCount,
        success,
        error
      });
      await writeWatchStatusArtifact(rootDir, {
        generatedAt: finishedAt.toISOString(),
        watchedRepoRoots,
        lastRun: {
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          inputDir: paths.inboxDir,
          reasons: runReasons,
          importedCount: importedCount + repoImportedCount + repoUpdatedCount,
          scannedCount: scannedCount + repoScannedCount,
          attachmentCount,
          changedPages,
          repoImportedCount,
          repoUpdatedCount,
          repoRemovedCount,
          repoScannedCount,
          pendingSemanticRefreshCount,
          pendingSemanticRefreshPaths,
          lintFindingCount,
          success,
          error
        },
        pendingSemanticRefresh: await readPendingSemanticRefresh(rootDir)
      });

      running = false;
      if (pending && !closed) {
        schedule("queued");
      }
    }
  };

  const reasonForPath = (targetPath: string) => {
    const baseDir =
      watchTargets
        .filter((watchTarget) => withinRoot(watchTarget, path.resolve(targetPath)))
        .sort((left, right) => right.length - left.length)[0] ?? paths.inboxDir;
    return path.relative(baseDir, targetPath) || ".";
  };

  watcher
    .on("add", (filePath) => schedule(`add:${reasonForPath(filePath)}`))
    .on("change", (filePath) => schedule(`change:${reasonForPath(filePath)}`))
    .on("unlink", (filePath) => schedule(`unlink:${reasonForPath(filePath)}`))
    .on("addDir", (dirPath) => schedule(`addDir:${reasonForPath(dirPath)}`))
    .on("unlinkDir", (dirPath) => schedule(`unlinkDir:${reasonForPath(dirPath)}`))
    .on("error", (caught) => schedule(`error:${caught instanceof Error ? caught.message : String(caught)}`));

  await new Promise<void>((resolve, reject) => {
    const handleReady = () => {
      watcher.off("error", handleError);
      resolve();
    };
    const handleError = (caught: unknown) => {
      watcher.off("ready", handleReady);
      reject(caught);
    };

    watcher.once("ready", handleReady);
    watcher.once("error", handleError);
  });

  return {
    close: async () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
      await watcher.close();
    }
  };
}

export async function getWatchStatus(rootDir: string): Promise<WatchStatusResult> {
  const persisted = await readWatchStatusArtifact(rootDir);
  const watchedRepoRoots = await listTrackedRepoRoots(rootDir);
  const pendingSemanticRefresh = await readPendingSemanticRefresh(rootDir);
  return {
    generatedAt: new Date().toISOString(),
    watchedRepoRoots,
    lastRun: persisted?.lastRun,
    pendingSemanticRefresh
  };
}
