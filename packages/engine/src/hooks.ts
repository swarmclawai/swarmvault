import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { GitHookStatus } from "./types.js";
import { ensureDir, fileExists } from "./utils.js";

const hookStart = "# >>> swarmvault hook >>>";
const hookEnd = "# <<< swarmvault hook <<<";

async function findNearestGitRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);
  try {
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (await fileExists(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveSwarmvaultExecutableCandidate(): string {
  const argvPath = process.argv[1];
  if (
    typeof argvPath === "string" &&
    argvPath.trim() &&
    (argvPath.includes(`${path.sep}@swarmvaultai${path.sep}cli${path.sep}`) ||
      argvPath.includes(`${path.sep}packages${path.sep}cli${path.sep}`))
  ) {
    return path.resolve(argvPath);
  }
  return "swarmvault";
}

function managedHookBlock(vaultRoot: string): string {
  const resolvedExecutable = resolveSwarmvaultExecutableCandidate();
  return [
    hookStart,
    `cd ${shellQuote(vaultRoot)} || exit 0`,
    `swarmvault_bin=${shellQuote(resolvedExecutable)}`,
    '[ ! -x "$swarmvault_bin" ] && swarmvault_bin=$(command -v swarmvault 2>/dev/null || true)',
    'if [ -n "$swarmvault_bin" ] && [ -x "$swarmvault_bin" ]; then',
    "  \"$swarmvault_bin\" watch --repo --once >/dev/null 2>&1 || printf '[swarmvault hook] refresh failed\\n' >&2",
    "fi",
    hookEnd,
    ""
  ].join("\n");
}

function hookPath(repoRoot: string, hookName: "post-commit" | "post-checkout"): string {
  return path.join(repoRoot, ".git", "hooks", hookName);
}

async function readHookStatus(filePath: string): Promise<GitHookStatus["postCommit"]> {
  if (!(await fileExists(filePath))) {
    return "not_installed";
  }
  const content = await fs.readFile(filePath, "utf8");
  return content.includes(hookStart) && content.includes(hookEnd) ? "installed" : "other_content";
}

async function upsertHookFile(filePath: string, block: string): Promise<void> {
  const existing = (await fileExists(filePath)) ? await fs.readFile(filePath, "utf8") : "";
  let next: string;

  const startIndex = existing.indexOf(hookStart);
  const endIndex = existing.indexOf(hookEnd);
  if (startIndex !== -1 && endIndex !== -1) {
    next = `${existing.slice(0, startIndex)}${block}${existing.slice(endIndex + hookEnd.length)}`.trimEnd();
  } else if (existing.trim().length > 0) {
    next = `${existing.trimEnd()}\n\n${block}`.trimEnd();
  } else {
    next = `#!/bin/sh\n${block}`.trimEnd();
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${next}\n`, { mode: 0o755, encoding: "utf8" });
  await fs.chmod(filePath, 0o755);
}

async function removeHookBlock(filePath: string): Promise<void> {
  if (!(await fileExists(filePath))) {
    return;
  }

  const existing = await fs.readFile(filePath, "utf8");
  const startIndex = existing.indexOf(hookStart);
  const endIndex = existing.indexOf(hookEnd);
  if (startIndex === -1 || endIndex === -1) {
    return;
  }

  const next = `${existing.slice(0, startIndex)}${existing.slice(endIndex + hookEnd.length)}`.trim();
  if (!next || next === "#!/bin/sh") {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, `${next}\n`, "utf8");
}

export async function getGitHookStatus(rootDir: string): Promise<GitHookStatus> {
  const repoRoot = await findNearestGitRoot(rootDir);
  if (!repoRoot) {
    return {
      repoRoot: null,
      postCommit: "not_installed",
      postCheckout: "not_installed"
    };
  }

  return {
    repoRoot,
    postCommit: await readHookStatus(hookPath(repoRoot, "post-commit")),
    postCheckout: await readHookStatus(hookPath(repoRoot, "post-checkout"))
  };
}

export async function installGitHooks(rootDir: string): Promise<GitHookStatus> {
  const repoRoot = await findNearestGitRoot(rootDir);
  if (!repoRoot) {
    throw new Error("No git repository found above the current vault.");
  }

  const block = managedHookBlock(path.resolve(rootDir));
  await upsertHookFile(hookPath(repoRoot, "post-commit"), block);
  await upsertHookFile(hookPath(repoRoot, "post-checkout"), block);
  return getGitHookStatus(rootDir);
}

export async function uninstallGitHooks(rootDir: string): Promise<GitHookStatus> {
  const repoRoot = await findNearestGitRoot(rootDir);
  if (!repoRoot) {
    return {
      repoRoot: null,
      postCommit: "not_installed",
      postCheckout: "not_installed"
    };
  }

  await removeHookBlock(hookPath(repoRoot, "post-commit"));
  await removeHookBlock(hookPath(repoRoot, "post-checkout"));
  return getGitHookStatus(rootDir);
}
