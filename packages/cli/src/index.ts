#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { GuidedSourceSessionQuestion, SourceClass } from "@swarmvaultai/engine";
import {
  acceptApproval,
  addInput,
  addManagedSource,
  archiveCandidate,
  benchmarkVault,
  compileVault,
  deleteManagedSource,
  explainGraphVault,
  exploreVault,
  exportGraphFormat,
  exportGraphHtml,
  getGitHookStatus,
  getWatchStatus,
  guideManagedSource,
  guideSourceScope,
  importInbox,
  ingestDirectory,
  ingestInputDetailed,
  initVault,
  installAgent,
  installGitHooks,
  lintVault,
  listApprovals,
  listCandidates,
  listGodNodes,
  listManagedSourceRecords,
  listManifests,
  listSchedules,
  loadVaultConfig,
  pathGraphVault,
  promoteCandidate,
  pushGraphNeo4j,
  queryGraphVault,
  queryVault,
  readApproval,
  rejectApproval,
  reloadManagedSources,
  resumeSourceSession,
  reviewManagedSource,
  reviewSourceScope,
  runSchedule,
  runWatchCycle,
  serveSchedules,
  startGraphServer,
  startMcpServer,
  uninstallGitHooks,
  watchVault
} from "@swarmvaultai/engine";
import { Command, Option } from "commander";
import { collectCliNotices, collectHeuristicProviderNotice } from "./notices.js";

const program = new Command();
const CLI_VERSION = readCliVersion();

program
  .name("swarmvault")
  .description("SwarmVault is a local-first knowledge compiler with graph outputs and optional provider-backed workflows.")
  .version(CLI_VERSION)
  .option("--json", "Emit structured JSON output", false);

function readCliVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version : "0.7.21";
  } catch {
    return "0.7.21";
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sourceScopeFromManifests(
  input: string,
  manifests: Array<{
    sourceId: string;
    title: string;
    sourceKind: string;
    sourceGroupId?: string;
    sourceGroupTitle?: string;
  }>
): { id: string; title: string; sourceIds: string[]; kind?: string } | null {
  if (!manifests.length) {
    return null;
  }
  const primary = manifests[0];
  return {
    id: primary?.sourceGroupId ?? primary?.sourceId ?? slugForCli(input),
    title: primary?.sourceGroupTitle ?? primary?.title ?? input,
    sourceIds: manifests.map((manifest) => manifest.sourceId),
    kind: primary?.sourceKind
  };
}

function slugForCli(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "source"
  );
}

function isJson(): boolean {
  return program.opts().json === true;
}

function emitJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function log(message: string): void {
  if (isJson()) {
    process.stderr.write(`${message}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

function emitNotice(message: string): void {
  process.stderr.write(`[swarmvault] ${message}\n`);
}

async function maybeEmitHeuristicNotice(commandPath: string[]): Promise<void> {
  if (isJson()) {
    return;
  }
  try {
    const { config } = await loadVaultConfig(process.cwd());
    const analysisTaskKeys = ["compileProvider", "queryProvider", "lintProvider"] as const;
    const usingHeuristic = analysisTaskKeys.every((task) => {
      const providerId = config.tasks[task];
      const providerConfig = config.providers[providerId];
      return !providerConfig || providerConfig.type === "heuristic";
    });
    if (!usingHeuristic) {
      return;
    }
    const notice = await collectHeuristicProviderNotice({
      commandPath,
      json: isJson()
    });
    if (notice) {
      emitNotice(notice);
    }
  } catch {
    // Workspace may not be initialized yet, or config may be unreadable.
    // Never let notice emission block or fail the real command.
  }
}

function canPromptGuide(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !isJson());
}

function readGuideAnswersFile(filePath: string | undefined): Record<string, string> | string[] | undefined {
  if (!filePath) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string");
  }
  if (raw && typeof raw === "object") {
    return Object.fromEntries(
      Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
    );
  }
  throw new Error("Guide answers files must contain either a JSON object keyed by question id or a JSON array of answers.");
}

async function promptGuideAnswers(questions: GuidedSourceSessionQuestion[]): Promise<Record<string, string>> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const promptLines = [question.prompt];
      if (question.answer) {
        promptLines.push(`Current: ${question.answer}`);
        promptLines.push("Press Enter to keep the current answer.");
      }
      const answer = (await rl.question(`${promptLines.join("\n")}\n> `)).trim();
      if (answer) {
        answers[question.id] = answer;
      } else if (question.answer) {
        answers[question.id] = question.answer;
      }
    }
    return answers;
  } finally {
    rl.close();
  }
}

async function completeGuideInteractively(
  guide: Awaited<ReturnType<typeof guideSourceScope>>,
  fallbackTarget: string
): Promise<Awaited<ReturnType<typeof guideSourceScope>>> {
  if (!guide.awaitingInput || !canPromptGuide()) {
    return guide;
  }
  const answers = await promptGuideAnswers(guide.questions);
  return await resumeSourceSession(process.cwd(), guide.sessionId || fallbackTarget, { answers });
}

function getCommandPath(command: Command): string[] {
  const names: string[] = [];
  let current: Command | null = command;
  while (current) {
    const name = current.name();
    if (name && name !== "swarmvault") {
      names.unshift(name);
    }
    current = current.parent ?? null;
  }
  return names;
}

program.hook("postAction", async (_thisCommand, actionCommand) => {
  const notices = await collectCliNotices({
    commandPath: getCommandPath(actionCommand),
    currentVersion: CLI_VERSION,
    json: isJson()
  });
  for (const notice of notices) {
    emitNotice(notice);
  }
});

program
  .command("init")
  .description("Initialize a SwarmVault workspace in the current directory.")
  .option("--obsidian", "Generate a minimal .obsidian workspace alongside the vault", false)
  .option(
    "--profile <profile>",
    "Starter workspace profile or comma-separated preset list (for example: personal-research or reader,timeline)"
  )
  .action(async (options: { obsidian?: boolean; profile?: string }) => {
    await initVault(process.cwd(), { obsidian: options.obsidian ?? false, profile: options.profile });
    if (isJson()) {
      emitJson({
        status: "initialized",
        rootDir: process.cwd(),
        obsidian: options.obsidian ?? false,
        profile: options.profile ?? "default"
      });
    } else {
      log("Initialized SwarmVault workspace.");
    }
  });

program
  .command("ingest")
  .description("Ingest a local file path, directory path, or URL into the raw SwarmVault workspace.")
  .argument("<input>", "Local file path, directory path, or URL")
  .option("--review", "Stage a source review artifact after ingest and compile", false)
  .option("--guide", "Stage a guided source integration bundle after ingest and compile (default: from config)")
  .option("--no-guide", "Skip guided mode even if enabled in config")
  .option("--answers-file <path>", "JSON file with guided-session answers keyed by question id or listed in prompt order")
  .option("--include-assets", "Download remote image assets when ingesting URLs", true)
  .option("--no-include-assets", "Skip downloading remote image assets when ingesting URLs")
  .option("--max-asset-size <bytes>", "Maximum number of bytes to fetch for a single remote image asset")
  .option("--repo-root <path>", "Override the detected repo root when ingesting a directory")
  .option("--include <glob...>", "Only ingest files matching one or more glob patterns")
  .option("--exclude <glob...>", "Skip files matching one or more glob patterns")
  .option("--max-files <n>", "Maximum number of files to ingest from a directory")
  .option("--include-third-party", "Also ingest repo files classified as third-party", false)
  .option("--include-resources", "Also ingest repo files classified as resources", false)
  .option("--include-generated", "Also ingest repo files classified as generated output", false)
  .option("--no-gitignore", "Ignore .gitignore rules when ingesting a directory")
  .action(
    async (
      input: string,
      options: {
        includeAssets?: boolean;
        maxAssetSize?: string;
        repoRoot?: string;
        include?: string[];
        exclude?: string[];
        maxFiles?: string;
        includeThirdParty?: boolean;
        includeResources?: boolean;
        includeGenerated?: boolean;
        gitignore?: boolean;
        review?: boolean;
        guide?: boolean;
        answersFile?: string;
      }
    ) => {
      const guideAnswers = readGuideAnswersFile(options.answersFile);
      const vaultConfig = await loadVaultConfig(process.cwd()).catch(() => null);
      const guideEnabled = options.guide ?? vaultConfig?.config.profile.guidedIngestDefault ?? false;
      const maxAssetSize =
        typeof options.maxAssetSize === "string" && options.maxAssetSize.trim()
          ? parsePositiveInt(options.maxAssetSize, 0) || undefined
          : undefined;
      const maxFiles =
        typeof options.maxFiles === "string" && options.maxFiles.trim() ? parsePositiveInt(options.maxFiles, 0) || undefined : undefined;
      const extractClasses: SourceClass[] = [
        "first_party",
        ...(options.includeThirdParty ? (["third_party"] as const) : []),
        ...(options.includeResources ? (["resource"] as const) : []),
        ...(options.includeGenerated ? (["generated"] as const) : [])
      ];
      const commonOptions = {
        includeAssets: options.includeAssets,
        maxAssetSize,
        repoRoot: options.repoRoot,
        include: options.include,
        exclude: options.exclude,
        maxFiles,
        gitignore: options.gitignore,
        extractClasses
      };
      const directoryResult = !/^https?:\/\//i.test(input)
        ? await import("node:fs/promises").then((fs) =>
            fs
              .stat(input)
              .then((stat) => (stat.isDirectory() ? ingestDirectory(process.cwd(), input, commonOptions) : null))
              .catch(() => null)
          )
        : null;
      if (directoryResult) {
        const scope =
          options.review || guideEnabled
            ? await (async () => {
                const pathModule = await import("node:path");
                const absoluteInput = pathModule.resolve(process.cwd(), input);
                const sourceIds = (await listManifests(process.cwd()))
                  .filter((manifest) => {
                    if (!manifest.originalPath) {
                      return false;
                    }
                    const relative = pathModule.relative(absoluteInput, pathModule.resolve(manifest.originalPath));
                    return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
                  })
                  .map((manifest) => manifest.sourceId);
                return sourceIds.length
                  ? {
                      id: `directory-${absoluteInput.split(pathModule.sep).pop() ?? "source"}`,
                      title: absoluteInput.split(pathModule.sep).pop() ?? absoluteInput,
                      sourceIds,
                      kind: "directory"
                    }
                  : undefined;
              })()
            : undefined;
        const shouldStage = Boolean(scope && (directoryResult.imported.length || directoryResult.updated.length));
        const review =
          shouldStage && options.review && !guideEnabled
            ? await (async () => {
                await compileVault(process.cwd(), {});
                return await reviewSourceScope(process.cwd(), scope!);
              })()
            : undefined;
        const guide =
          shouldStage && guideEnabled
            ? await (async () => {
                await compileVault(process.cwd(), {});
                return await guideSourceScope(process.cwd(), scope!, { answers: guideAnswers });
              })()
            : undefined;
        const completedGuide = guide && !options.answersFile ? await completeGuideInteractively(guide, scope?.id ?? input) : guide;
        if (isJson()) {
          emitJson(
            completedGuide
              ? { ingest: directoryResult, guide: completedGuide }
              : review
                ? { ingest: directoryResult, review }
                : directoryResult
          );
        } else {
          log(
            `Imported ${directoryResult.imported.length} file(s), updated ${directoryResult.updated.length}, skipped ${directoryResult.skipped.length}.`
          );
          if (review) {
            log(`Staged source review at ${review.reviewPath}.`);
          }
          if (completedGuide?.awaitingInput) {
            log(
              `Created guided session at ${completedGuide.sessionPath}. Resume with \`swarmvault source session ${completedGuide.sessionId}\`.`
            );
          } else if (completedGuide?.guidePath) {
            log(`Staged guided session at ${completedGuide.guidePath}.`);
          }
        }
        return;
      }
      const ingest = await ingestInputDetailed(process.cwd(), input, commonOptions);
      const scope = sourceScopeFromManifests(input, [...ingest.created, ...ingest.updated, ...ingest.unchanged]);
      const review =
        options.review && !guideEnabled && scope && (ingest.created.length || ingest.updated.length || ingest.unchanged.length)
          ? await (async () => {
              await compileVault(process.cwd(), {});
              return await reviewSourceScope(process.cwd(), scope);
            })()
          : undefined;
      const guide =
        guideEnabled && scope && (ingest.created.length || ingest.updated.length || ingest.unchanged.length)
          ? await (async () => {
              await compileVault(process.cwd(), {});
              return await guideSourceScope(process.cwd(), scope, { answers: guideAnswers });
            })()
          : undefined;
      const completedGuide = guide && !options.answersFile ? await completeGuideInteractively(guide, scope?.id ?? input) : guide;
      if (isJson()) {
        emitJson(completedGuide ? { ingest, guide: completedGuide } : review ? { ingest, review } : ingest);
      } else {
        const primary = [...ingest.created, ...ingest.updated, ...ingest.unchanged][0];
        if (ingest.created.length + ingest.updated.length + ingest.removed.length <= 1 && primary) {
          log(primary.sourceId);
        } else {
          log(
            `Created ${ingest.created.length}, updated ${ingest.updated.length}, unchanged ${ingest.unchanged.length}, removed ${ingest.removed.length}.`
          );
        }
        if (review) {
          log(`Staged source review at ${review.reviewPath}.`);
        }
        if (completedGuide?.awaitingInput) {
          log(
            `Created guided session at ${completedGuide.sessionPath}. Resume with \`swarmvault source session ${completedGuide.sessionId}\`.`
          );
        } else if (completedGuide?.guidePath) {
          log(`Staged guided session at ${completedGuide.guidePath}.`);
        }
      }
    }
  );

program
  .command("add")
  .description("Capture supported URLs into normalized markdown before ingesting them.")
  .argument("<input>", "Supported URL or bare arXiv id")
  .option("--author <name>", "Human author or curator for this capture")
  .option("--contributor <name>", "Additional contributor metadata for this capture")
  .action(async (input: string, options: { author?: string; contributor?: string }) => {
    const result = await addInput(process.cwd(), input, {
      author: options.author,
      contributor: options.contributor
    });
    if (isJson()) {
      emitJson(result);
    } else {
      log(`${result.captureType}${result.fallback ? " (fallback)" : ""}: ${result.manifest.sourceId}`);
    }
  });

const source = program.command("source").description("Manage recurring local files, directories, public repos, and docs sources.");

source
  .command("add")
  .description("Register and sync a managed source from a local file, directory, public GitHub repo root URL, or docs hub URL.")
  .argument("<input>", "Local file path, directory path, public GitHub repo root URL, or docs hub URL")
  .option("--no-compile", "Register and sync without compiling the vault")
  .option("--no-brief", "Skip source brief generation after sync")
  .option("--review", "Stage a source review artifact after sync and compile", false)
  .option("--guide", "Stage a guided source integration bundle after sync and compile (default: from config)")
  .option("--no-guide", "Skip guided mode even if enabled in config")
  .option("--answers-file <path>", "JSON file with guided-session answers keyed by question id or listed in prompt order")
  .option("--max-pages <n>", "Maximum number of pages to crawl for docs sources")
  .option("--max-depth <n>", "Maximum crawl depth for docs sources")
  .action(
    async (
      input: string,
      options: {
        compile?: boolean;
        brief?: boolean;
        review?: boolean;
        guide?: boolean;
        answersFile?: string;
        maxPages?: string;
        maxDepth?: string;
      }
    ) => {
      const guideAnswers = readGuideAnswersFile(options.answersFile);
      const addConfig = await loadVaultConfig(process.cwd()).catch(() => null);
      const guideEnabled = options.guide ?? addConfig?.config.profile.guidedIngestDefault ?? false;
      const result = await addManagedSource(process.cwd(), input, {
        compile: options.compile,
        brief: options.brief,
        review: options.review,
        guide: guideEnabled,
        guideAnswers,
        maxPages: options.maxPages ? parsePositiveInt(options.maxPages, 0) || undefined : undefined,
        maxDepth: options.maxDepth ? parsePositiveInt(options.maxDepth, 0) || undefined : undefined
      });
      if (result.guide && !options.answersFile) {
        result.guide = await completeGuideInteractively(result.guide, result.source.id);
      }
      if (isJson()) {
        emitJson(result);
      } else {
        log(
          `Registered ${result.source.kind} source ${result.source.id}. Status: ${result.source.status}.` +
            `${result.compile ? ` Compiled ${result.compile.sourceCount} source(s).` : ""}` +
            `${result.briefGenerated ? ` Brief: ${result.source.briefPath}` : ""}` +
            `${result.review ? ` Review: ${result.review.reviewPath}` : ""}` +
            `${
              result.guide?.awaitingInput
                ? ` Session: ${result.guide.sessionPath}. Resume with \`swarmvault source session ${result.guide.sessionId}\`.`
                : result.guide?.guidePath
                  ? ` Guide: ${result.guide.guidePath}`
                  : ""
            }`
        );
      }
    }
  );

source
  .command("list")
  .description("List managed sources registered in this vault.")
  .action(async () => {
    const sources = await listManagedSourceRecords(process.cwd());
    if (isJson()) {
      emitJson(sources);
    } else if (sources.length === 0) {
      log("No managed sources registered.");
    } else {
      for (const entry of sources) {
        log(`${entry.id}  ${entry.kind}  ${entry.status}  ${entry.title}`);
      }
    }
  });

source
  .command("reload")
  .description("Re-sync one managed source or all managed sources, then optionally compile and refresh briefs.")
  .argument("[id]", "Managed source id")
  .option("--all", "Reload all managed sources", false)
  .option("--no-compile", "Re-sync without compiling the vault")
  .option("--no-brief", "Skip source brief generation after sync")
  .option("--review", "Stage a source review artifact after sync and compile", false)
  .option("--guide", "Stage a guided source integration bundle after sync and compile (default: from config)")
  .option("--no-guide", "Skip guided mode even if enabled in config")
  .option("--answers-file <path>", "JSON file with guided-session answers keyed by question id or listed in prompt order")
  .option("--max-pages <n>", "Maximum number of pages to crawl for docs sources")
  .option("--max-depth <n>", "Maximum crawl depth for docs sources")
  .action(
    async (
      id: string | undefined,
      options: {
        all?: boolean;
        compile?: boolean;
        brief?: boolean;
        review?: boolean;
        guide?: boolean;
        answersFile?: string;
        maxPages?: string;
        maxDepth?: string;
      }
    ) => {
      const guideAnswers = readGuideAnswersFile(options.answersFile);
      const reloadConfig = await loadVaultConfig(process.cwd()).catch(() => null);
      const guideEnabled = options.guide ?? reloadConfig?.config.profile.guidedIngestDefault ?? false;
      const result = await reloadManagedSources(process.cwd(), {
        id,
        all: options.all ?? false,
        compile: options.compile,
        brief: options.brief,
        review: options.review,
        guide: guideEnabled,
        guideAnswers,
        maxPages: options.maxPages ? parsePositiveInt(options.maxPages, 0) || undefined : undefined,
        maxDepth: options.maxDepth ? parsePositiveInt(options.maxDepth, 0) || undefined : undefined
      });
      if (!options.answersFile && result.guides.length === 1) {
        result.guides = [await completeGuideInteractively(result.guides[0]!, result.sources[0]?.id ?? id ?? "source")];
      }
      if (isJson()) {
        emitJson(result);
      } else {
        log(
          `Reloaded ${result.sources.length} source(s).` +
            `${result.compile ? ` Compiled ${result.compile.sourceCount} source(s).` : ""}` +
            `${result.briefPaths.length ? ` Briefs: ${result.briefPaths.length}.` : ""}` +
            `${result.reviews.length ? ` Reviews: ${result.reviews.length}.` : ""}` +
            `${result.guides.length ? ` Guides/Sessions: ${result.guides.length}.` : ""}`
        );
      }
    }
  );

source
  .command("delete")
  .description("Unregister a managed source and remove its transient sync state without deleting canonical vault content.")
  .argument("<id>", "Managed source id")
  .action(async (id: string) => {
    const result = await deleteManagedSource(process.cwd(), id);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Deleted managed source ${result.removed.id}. Canonical vault content was left in place.`);
    }
  });

source
  .command("review")
  .description("Stage a source review artifact for a managed source id or raw source id.")
  .argument("<id>", "Managed source id or raw source id")
  .action(async (id: string) => {
    const result = await reviewManagedSource(process.cwd(), id);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Staged source review at ${result.reviewPath}.`);
    }
  });

source
  .command("guide")
  .description("Create or resume a guided source session for a managed source id or raw source id.")
  .argument("<id>", "Managed source id or raw source id")
  .option("--answers-file <path>", "JSON file with guided-session answers keyed by question id or listed in prompt order")
  .action(async (id: string, options: { answersFile?: string }) => {
    const guideAnswers = readGuideAnswersFile(options.answersFile);
    let result = await guideManagedSource(process.cwd(), id, { answers: guideAnswers });
    if (!options.answersFile) {
      result = await completeGuideInteractively(result, id);
    }
    if (isJson()) {
      emitJson(result);
    } else {
      if (result.awaitingInput) {
        log(`Created guided session at ${result.sessionPath}. Resume with \`swarmvault source session ${result.sessionId}\`.`);
      } else {
        log(`Staged guided session at ${result.guidePath}.`);
      }
    }
  });

source
  .command("session")
  .description("Resume the latest guided source session for a managed source id, raw source id, source scope id, or session id.")
  .argument("<id>", "Managed source id, raw source id, source scope id, or guided session id")
  .option("--answers-file <path>", "JSON file with guided-session answers keyed by question id or listed in prompt order")
  .action(async (id: string, options: { answersFile?: string }) => {
    const guideAnswers = readGuideAnswersFile(options.answersFile);
    let result = await resumeSourceSession(process.cwd(), id, { answers: guideAnswers });
    if (!options.answersFile) {
      result = await completeGuideInteractively(result, id);
    }
    if (isJson()) {
      emitJson(result);
    } else if (result.awaitingInput) {
      log(`Updated guided session at ${result.sessionPath}. Resume with \`swarmvault source session ${result.sessionId}\` when ready.`);
    } else {
      log(`Staged guided session at ${result.guidePath}.`);
    }
  });

const inbox = program.command("inbox").description("Inbox and capture workflows.");
inbox
  .command("import")
  .description("Import supported files from the configured inbox directory.")
  .argument("[dir]", "Optional inbox directory override")
  .action(async (dir?: string) => {
    const result = await importInbox(process.cwd(), dir);
    if (isJson()) {
      emitJson(result);
    } else {
      log(
        `Imported ${result.imported.length} source(s) from ${result.inputDir}. Scanned: ${result.scannedCount}. Attachments: ${result.attachmentCount}. Skipped: ${result.skipped.length}.`
      );
    }
  });

program
  .command("compile")
  .description("Compile manifests into wiki pages, graph JSON, and search index.")
  .option("--approve", "Stage a review bundle without applying active page changes", false)
  .action(async (options: { approve?: boolean }) => {
    const result = await compileVault(process.cwd(), { approve: options.approve ?? false });
    if (isJson()) {
      emitJson(result);
    } else {
      if (result.staged) {
        log(`Staged ${result.changedPages.length} change(s) for review at ${result.approvalDir}.`);
      } else {
        log(`Compiled ${result.sourceCount} source(s), ${result.pageCount} page(s). Changed: ${result.changedPages.length}.`);
      }
    }
    await maybeEmitHeuristicNotice(["compile"]);
  });

program
  .command("query")
  .description("Query the compiled SwarmVault wiki.")
  .argument("<question>", "Question to ask SwarmVault")
  .option("--no-save", "Do not persist the answer to wiki/outputs")
  .addOption(
    new Option("--format <format>", "Output format").choices(["markdown", "report", "slides", "chart", "image"]).default("markdown")
  )
  .action(async (question: string, options: { save?: boolean; format?: "markdown" | "report" | "slides" | "chart" | "image" }) => {
    const result = await queryVault(process.cwd(), {
      question,
      save: options.save ?? true,
      format: options.format
    });
    if (isJson()) {
      emitJson(result);
    } else {
      log(result.answer);
      if (result.savedPath) {
        log(`Saved to ${result.savedPath}`);
      }
    }
    await maybeEmitHeuristicNotice(["query"]);
  });

program
  .command("explore")
  .description("Run a save-first multi-step exploration loop against the vault.")
  .argument("<question>", "Root question to explore")
  .option("--steps <n>", "Maximum number of exploration steps", "3")
  .addOption(
    new Option("--format <format>", "Output format for step pages")
      .choices(["markdown", "report", "slides", "chart", "image"])
      .default("markdown")
  )
  .action(async (question: string, options: { steps?: string; format?: "markdown" | "report" | "slides" | "chart" | "image" }) => {
    const stepCount = parsePositiveInt(options.steps, 3);
    const result = await exploreVault(process.cwd(), {
      question,
      steps: stepCount,
      format: options.format
    });
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Exploration hub saved to ${result.hubPath}`);
      log(`Completed ${result.stepCount} step(s).`);
    }
    await maybeEmitHeuristicNotice(["explore"]);
  });

program
  .command("benchmark")
  .description("Measure graph-guided context reduction against a naive full-corpus read.")
  .option("--question <text...>", "Optional custom benchmark question(s)")
  .action(async (options: { question?: string[] }) => {
    const result = await benchmarkVault(process.cwd(), {
      questions: options.question
    });
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Corpus tokens: ${result.corpusTokens}`);
      log(`Average query tokens: ${result.avgQueryTokens}`);
      const ratioPercent = (result.reductionRatio * 100).toFixed(1);
      log(`Reduction ratio: ${ratioPercent}%`);
      if (result.reductionRatio < 0) {
        log(
          "Note: graph-guided context is larger than the full corpus on this vault. The benchmark is only meaningful once the corpus exceeds the graph traversal budget."
        );
      }
    }
  });

program
  .command("lint")
  .description("Run anti-drift and wiki-health checks.")
  .option("--deep", "Run LLM-powered advisory lint (default: from config)")
  .option("--no-deep", "Skip deep lint even if enabled in config")
  .option("--web", "Augment deep lint with configured web search", false)
  .option("--conflicts", "Filter to contradiction findings only", false)
  .action(async (options: { deep?: boolean; web?: boolean; conflicts?: boolean }) => {
    const lintConfig = await loadVaultConfig(process.cwd()).catch(() => null);
    const deepEnabled = options.deep ?? lintConfig?.config.profile.deepLintDefault ?? false;
    const findings = await lintVault(process.cwd(), {
      deep: deepEnabled,
      web: options.web ?? false,
      conflicts: options.conflicts ?? false
    });
    if (isJson()) {
      emitJson(findings);
      return;
    }
    if (!findings.length) {
      log("No findings.");
      return;
    }
    for (const finding of findings) {
      log(`[${finding.severity}] ${finding.code}: ${finding.message}${finding.pagePath ? ` (${finding.pagePath})` : ""}`);
    }
  });

const graph = program.command("graph").description("Graph-related commands.");
const graphPush = graph.command("push").description("Push the compiled graph into external sinks.");

graphPush
  .command("neo4j")
  .description("Push the compiled graph directly into Neo4j over Bolt/Aura.")
  .option("--uri <bolt-uri>", "Neo4j Bolt or Aura URI")
  .option("--username <user>", "Neo4j username")
  .option("--password-env <env-var>", "Environment variable containing the Neo4j password")
  .option("--database <name>", "Neo4j database name")
  .option("--vault-id <id>", "Stable vault identifier used for shared-database namespacing")
  .option("--batch-size <n>", "Maximum rows to write per Neo4j transaction batch")
  .option("--include-third-party", "Also push third-party repo material", false)
  .option("--include-resources", "Also push resource-like content", false)
  .option("--include-generated", "Also push generated output", false)
  .option("--dry-run", "Show what would be pushed without writing to Neo4j", false)
  .action(
    async (options: {
      uri?: string;
      username?: string;
      passwordEnv?: string;
      database?: string;
      vaultId?: string;
      batchSize?: string;
      includeThirdParty?: boolean;
      includeResources?: boolean;
      includeGenerated?: boolean;
      dryRun?: boolean;
    }) => {
      const batchSize =
        typeof options.batchSize === "string" && options.batchSize.trim() ? parsePositiveInt(options.batchSize, 0) || undefined : undefined;
      const includeClasses: SourceClass[] = [
        "first_party",
        ...(options.includeThirdParty ? (["third_party"] as const) : []),
        ...(options.includeResources ? (["resource"] as const) : []),
        ...(options.includeGenerated ? (["generated"] as const) : [])
      ];
      const result = await pushGraphNeo4j(process.cwd(), {
        uri: options.uri,
        username: options.username,
        passwordEnv: options.passwordEnv,
        database: options.database,
        vaultId: options.vaultId,
        batchSize,
        includeClasses,
        dryRun: options.dryRun ?? false
      });
      if (isJson()) {
        emitJson(result);
      } else {
        log(
          `${result.dryRun ? "Planned" : "Pushed"} ${result.counts.nodes} nodes, ${result.counts.relationships} relationships, ${result.counts.hyperedges} hyperedges, and ${result.counts.groupMembers} group-member links to ${result.uri}/${result.database} as ${result.vaultId}.`
        );
        if (result.skipped.nodes || result.skipped.relationships || result.skipped.hyperedges) {
          log(
            `Skipped ${result.skipped.nodes} node(s), ${result.skipped.relationships} relationship(s), and ${result.skipped.hyperedges} hyperedge(s) outside the selected source classes.`
          );
        }
        for (const warning of result.warnings) {
          log(`Warning: ${warning}`);
        }
      }
    }
  );

graph
  .command("serve")
  .description("Serve the local graph viewer.")
  .option("--port <port>", "Port override")
  .option("--full", "Disable overview sampling and render the full graph", false)
  .action(async (options: { port?: string; full?: boolean }) => {
    const port = options.port ? parsePositiveInt(options.port, 0) || undefined : undefined;
    const server = await startGraphServer(process.cwd(), port, { full: options.full ?? false });
    if (isJson()) {
      emitJson({ port: server.port, url: `http://localhost:${server.port}` });
    } else {
      log(`Graph viewer running at http://localhost:${server.port}`);
    }
    process.on("SIGINT", async () => {
      try {
        await server.close();
      } catch {}
      process.exit(0);
    });
  });

graph
  .command("export")
  .description("Export the graph as HTML, SVG, GraphML, or Cypher. Combine flags to write multiple formats in one run.")
  .option("--html <output>", "Output HTML file path")
  .option("--svg <output>", "Output SVG file path")
  .option("--graphml <output>", "Output GraphML file path")
  .option("--cypher <output>", "Output Cypher file path")
  .option("--full", "Disable overview sampling for HTML export", false)
  .action(async (options: { html?: string; svg?: string; graphml?: string; cypher?: string; full?: boolean }) => {
    const targets = [
      options.html ? ({ format: "html", outputPath: options.html } as const) : null,
      options.svg ? ({ format: "svg", outputPath: options.svg } as const) : null,
      options.graphml ? ({ format: "graphml", outputPath: options.graphml } as const) : null,
      options.cypher ? ({ format: "cypher", outputPath: options.cypher } as const) : null
    ].filter((target): target is NonNullable<typeof target> => Boolean(target));

    if (targets.length === 0) {
      throw new Error("Pass at least one of --html, --svg, --graphml, or --cypher.");
    }

    const results: Array<{ format: string; outputPath: string }> = [];
    for (const target of targets) {
      const outputPath =
        target.format === "html"
          ? await exportGraphHtml(process.cwd(), target.outputPath, { full: options.full ?? false })
          : (await exportGraphFormat(process.cwd(), target.format, target.outputPath)).outputPath;
      results.push({ format: target.format, outputPath });
    }

    if (isJson()) {
      emitJson(results.length === 1 ? results[0] : { exports: results });
    } else {
      for (const result of results) {
        log(`Exported graph ${result.format} to ${result.outputPath}`);
      }
    }
  });

graph
  .command("query")
  .description("Traverse the compiled graph deterministically from local search seeds.")
  .argument("<question>", "Question or graph search seed")
  .option("--dfs", "Prefer a depth-first traversal instead of breadth-first", false)
  .option("--budget <n>", "Maximum number of graph nodes to summarize")
  .action(async (question: string, options: { dfs?: boolean; budget?: string }) => {
    const budget = options.budget ? parsePositiveInt(options.budget, 0) || undefined : undefined;
    const result = await queryGraphVault(process.cwd(), question, {
      traversal: options.dfs ? "dfs" : "bfs",
      budget
    });
    if (isJson()) {
      emitJson(result);
      return;
    }
    log(result.summary);
  });

graph
  .command("path")
  .description("Find the shortest graph path between two nodes or pages.")
  .argument("<from>", "Source node/page label or id")
  .argument("<to>", "Target node/page label or id")
  .action(async (from: string, to: string) => {
    const result = await pathGraphVault(process.cwd(), from, to);
    if (isJson()) {
      emitJson(result);
      return;
    }
    log(result.summary);
  });

graph
  .command("explain")
  .description("Explain a graph node, its page, community, and neighbors.")
  .argument("<target>", "Node/page label or id")
  .action(async (target: string) => {
    const result = await explainGraphVault(process.cwd(), target);
    if (isJson()) {
      emitJson(result);
      return;
    }
    log(result.summary);
  });

graph
  .command("god-nodes")
  .description("List the highest-connectivity non-source graph nodes.")
  .option("--limit <n>", "Maximum number of nodes to return", "10")
  .action(async (options: { limit?: string }) => {
    const limit = parsePositiveInt(options.limit, 10);
    const result = await listGodNodes(process.cwd(), limit);
    if (isJson()) {
      emitJson(result);
      return;
    }
    for (const node of result) {
      log(`${node.label} degree=${node.degree ?? 0} bridge=${node.bridgeScore ?? 0}`);
    }
  });

const review = program.command("review").description("Review staged compile approval bundles.");
review
  .command("list")
  .description("List staged approval bundles and their resolution status.")
  .action(async () => {
    const approvals = await listApprovals(process.cwd());
    if (isJson()) {
      emitJson(approvals);
      return;
    }
    if (!approvals.length) {
      log("No approval bundles.");
      return;
    }
    for (const approval of approvals) {
      log(
        `${approval.approvalId}${approval.bundleType ? ` [${approval.bundleType}]` : ""}${approval.title ? ` ${approval.title}` : ""} pending=${approval.pendingCount} accepted=${approval.acceptedCount} rejected=${approval.rejectedCount} created=${approval.createdAt}`
      );
    }
  });

review
  .command("show")
  .description("Show the entries inside a staged approval bundle.")
  .argument("<approvalId>", "Approval bundle identifier")
  .option("--diff", "Show unified diff for each entry", false)
  .action(async (approvalId: string, options: { diff?: boolean }) => {
    const approval = await readApproval(process.cwd(), approvalId, { diff: options.diff });
    if (isJson()) {
      emitJson(approval);
      return;
    }
    log(
      `${approval.approvalId}${approval.bundleType ? ` [${approval.bundleType}]` : ""}${approval.title ? ` ${approval.title}` : ""} pending=${approval.pendingCount} accepted=${approval.acceptedCount} rejected=${approval.rejectedCount}`
    );
    for (const entry of approval.entries) {
      log(
        `- ${entry.status} ${entry.changeType}${entry.label ? ` [${entry.label}]` : ""} ${entry.pageId} ${entry.nextPath ?? entry.previousPath ?? ""}`.trim()
      );
      if (entry.changeSummary) log(`  Summary: ${entry.changeSummary}`);
      if (entry.diff) {
        log("");
        log(entry.diff);
        log("");
      }
    }
  });

review
  .command("accept")
  .description("Accept all pending entries, or selected entries, from a staged approval bundle.")
  .argument("<approvalId>", "Approval bundle identifier")
  .argument("[targets...]", "Optional page ids or paths to accept")
  .action(async (approvalId: string, targets: string[]) => {
    const result = await acceptApproval(process.cwd(), approvalId, targets);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Accepted ${result.updatedEntries.length} entr${result.updatedEntries.length === 1 ? "y" : "ies"} from ${approvalId}.`);
    }
  });

review
  .command("reject")
  .description("Reject all pending entries, or selected entries, from a staged approval bundle.")
  .argument("<approvalId>", "Approval bundle identifier")
  .argument("[targets...]", "Optional page ids or paths to reject")
  .action(async (approvalId: string, targets: string[]) => {
    const result = await rejectApproval(process.cwd(), approvalId, targets);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Rejected ${result.updatedEntries.length} entr${result.updatedEntries.length === 1 ? "y" : "ies"} from ${approvalId}.`);
    }
  });

const candidate = program.command("candidate").description("Candidate page workflows.");
candidate
  .command("list")
  .description("List staged concept and entity candidates.")
  .action(async () => {
    const candidates = await listCandidates(process.cwd());
    if (isJson()) {
      emitJson(candidates);
      return;
    }
    if (!candidates.length) {
      log("No candidates.");
      return;
    }
    for (const entry of candidates) {
      log(`${entry.pageId} ${entry.path} -> ${entry.activePath}`);
    }
  });

candidate
  .command("promote")
  .description("Promote a candidate into its active concept or entity path.")
  .argument("<target>", "Candidate page id or path")
  .action(async (target: string) => {
    const result = await promoteCandidate(process.cwd(), target);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Promoted ${result.pageId} to ${result.path}`);
    }
  });

candidate
  .command("archive")
  .description("Archive a candidate by removing it from the active candidate set.")
  .argument("<target>", "Candidate page id or path")
  .action(async (target: string) => {
    const result = await archiveCandidate(process.cwd(), target);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Archived ${result.pageId}`);
    }
  });

const watch = program
  .command("watch")
  .description("Watch the inbox directory and optionally tracked repos, or run one refresh cycle immediately.")
  .option("--lint", "Run lint after each compile cycle", false)
  .option("--repo", "Also refresh tracked repo sources and watch their repo roots", false)
  .option("--once", "Run one import/refresh cycle immediately instead of starting a watcher", false)
  .option("--debounce <ms>", "Debounce window in milliseconds", "900")
  .action(async (options: { lint?: boolean; repo?: boolean; once?: boolean; debounce?: string }) => {
    const debounceMs = parsePositiveInt(options.debounce, 900);
    if (options.once) {
      const result = await runWatchCycle(process.cwd(), {
        lint: options.lint ?? false,
        repo: options.repo ?? false,
        debounceMs
      });
      if (isJson()) {
        emitJson(result);
      } else {
        log(
          `Refreshed inbox${options.repo ? " and tracked repos" : ""}. Imported ${result.importedCount}, repo imported ${result.repoImportedCount}, repo updated ${result.repoUpdatedCount}, repo removed ${result.repoRemovedCount}.`
        );
      }
      return;
    }
    const { paths } = await loadVaultConfig(process.cwd());
    const controller = await watchVault(process.cwd(), {
      lint: options.lint ?? false,
      repo: options.repo ?? false,
      debounceMs
    });
    if (isJson()) {
      emitJson({ status: "watching", inboxDir: paths.inboxDir, repo: options.repo ?? false });
    } else {
      log(`Watching inbox${options.repo ? " and tracked repos" : ""} for changes. Press Ctrl+C to stop.`);
    }
    process.on("SIGINT", async () => {
      try {
        await controller.close();
      } catch {}
      process.exit(0);
    });
  });

async function showWatchStatus(): Promise<void> {
  const result = await getWatchStatus(process.cwd());
  if (isJson()) {
    emitJson(result);
    return;
  }
  log(`Watched repo roots: ${result.watchedRepoRoots.length}`);
  log(`Pending semantic refresh: ${result.pendingSemanticRefresh.length}`);
  for (const entry of result.pendingSemanticRefresh.slice(0, 8)) {
    log(`- ${entry.changeType} ${entry.path}`);
  }
}

watch.command("status").description("Show the latest watch run plus pending semantic refresh entries.").action(showWatchStatus);

program.command("watch-status").description("Show the latest watch run plus pending semantic refresh entries.").action(showWatchStatus);

const hook = program.command("hook").description("Install local git hooks that keep tracked repos and the vault in sync.");
hook
  .command("install")
  .description("Install post-commit and post-checkout hooks for the nearest git repository.")
  .action(async () => {
    const status = await installGitHooks(process.cwd());
    if (isJson()) {
      emitJson(status);
      return;
    }
    log(`Installed hooks in ${status.repoRoot}`);
  });

hook
  .command("uninstall")
  .description("Remove the SwarmVault-managed git hook blocks from the nearest git repository.")
  .action(async () => {
    const status = await uninstallGitHooks(process.cwd());
    if (isJson()) {
      emitJson(status);
      return;
    }
    log(`Removed SwarmVault hook blocks from ${status.repoRoot ?? "the current workspace"}`);
  });

hook
  .command("status")
  .description("Show whether SwarmVault-managed git hooks are installed.")
  .action(async () => {
    const status = await getGitHookStatus(process.cwd());
    if (isJson()) {
      emitJson(status);
      return;
    }
    if (!status.repoRoot) {
      log("No git repository found.");
      return;
    }
    log(`repo=${status.repoRoot}`);
    log(`post-commit=${status.postCommit}`);
    log(`post-checkout=${status.postCheckout}`);
  });

const schedule = program.command("schedule").description("Run scheduled vault maintenance jobs.");
schedule
  .command("list")
  .description("List configured schedule jobs and their next run state.")
  .action(async () => {
    const schedules = await listSchedules(process.cwd());
    if (isJson()) {
      emitJson(schedules);
      return;
    }
    if (!schedules.length) {
      log("No schedules configured.");
      return;
    }
    for (const entry of schedules) {
      log(
        `${entry.jobId} enabled=${entry.enabled} task=${entry.taskType} next=${entry.nextRunAt ?? "n/a"} last=${entry.lastRunAt ?? "never"} status=${entry.lastStatus ?? "n/a"} approval=${entry.lastApprovalId ?? "none"}`
      );
    }
  });

schedule
  .command("run")
  .description("Run one configured schedule job immediately.")
  .argument("<jobId>", "Schedule identifier")
  .action(async (jobId: string) => {
    const result = await runSchedule(process.cwd(), jobId);
    if (isJson()) {
      emitJson(result);
      return;
    }
    log(
      `${jobId} ${result.success ? "completed" : "failed"} (${result.taskType})${result.approvalId ? ` approval=${result.approvalId}` : ""}${
        result.error ? ` error=${result.error}` : ""
      }`
    );
  });

schedule
  .command("serve")
  .description("Run the local schedule loop.")
  .option("--poll <ms>", "Polling interval in milliseconds", "30000")
  .action(async (options: { poll?: string }) => {
    const pollMs = parsePositiveInt(options.poll, 30_000);
    const controller = await serveSchedules(process.cwd(), pollMs);
    if (isJson()) {
      emitJson({ status: "serving", pollMs });
    } else {
      log("Serving schedules. Press Ctrl+C to stop.");
    }
    process.on("SIGINT", async () => {
      try {
        await controller.close();
      } catch {}
      process.exit(0);
    });
  });

program
  .command("mcp")
  .description("Run SwarmVault as a local MCP server over stdio.")
  .action(async () => {
    if (isJson()) {
      process.stderr.write(`${JSON.stringify({ status: "running", transport: "stdio" })}\n`);
    }
    const controller = await startMcpServer(process.cwd());
    process.on("SIGINT", async () => {
      try {
        await controller.close();
      } catch {}
      process.exit(0);
    });
  });

program
  .command("install")
  .description("Install SwarmVault instructions for an agent in the current project.")
  .requiredOption("--agent <agent>", "codex, claude, cursor, goose, pi, gemini, opencode, aider, or copilot")
  .option("--hook", "Also install hook/plugin guidance when the target agent supports it", false)
  .action(
    async (options: {
      agent: "codex" | "claude" | "cursor" | "goose" | "pi" | "gemini" | "opencode" | "aider" | "copilot";
      hook?: boolean;
    }) => {
      const hookCapableAgents = new Set(["claude", "opencode", "gemini", "copilot"]);
      if (options.hook && !hookCapableAgents.has(options.agent)) {
        throw new Error("--hook is only supported for --agent claude, opencode, gemini, or copilot");
      }
      const result = await installAgent(process.cwd(), options.agent, { hook: options.hook ?? false });
      if (isJson()) {
        emitJson({ ...result, hook: options.hook ?? false });
      } else {
        log(`Installed rules into ${result.target}`);
        if (result.targets.length > 1) {
          log(`Also wrote: ${result.targets.filter((entry) => entry !== result.target).join(", ")}`);
        }
        for (const warning of result.warnings ?? []) {
          emitNotice(warning);
        }
      }
    }
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (isJson()) {
    emitJson({ error: message });
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
});
