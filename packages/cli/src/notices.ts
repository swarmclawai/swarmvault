import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const NOTICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NOTICE_TIMEOUT_MS = 2_000;
const STAR_URL = "https://github.com/swarmclawai/swarmvault";
const NPM_PACKAGE = "@swarmvaultai/cli";
const SUPPRESSED_COMMANDS = new Set(["graph serve", "mcp", "schedule serve", "watch"]);

export interface CliNoticeState {
  lastUpdateCheckAt?: string;
  lastSeenLatestVersion?: string;
  starPromptShown?: boolean;
}

export interface CliNoticeOptions {
  commandPath: string[];
  currentVersion: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  statePath?: string;
  stderrIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  fetchLatestVersion?: () => Promise<string | null>;
}

export function resolveCliStatePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SWARMVAULT_CLI_STATE_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }
  const homeDir = os.homedir();
  if (!homeDir) {
    return null;
  }
  return path.join(homeDir, ".swarmvault", "cli-state.json");
}

export function shouldEmitCliNotices(options: CliNoticeOptions): boolean {
  const env = options.env ?? process.env;
  if (options.json) {
    return false;
  }
  if (env.SWARMVAULT_NO_NOTICES === "1") {
    return false;
  }
  if (Boolean(env.CI) && env.CI !== "0") {
    return false;
  }
  if (!(options.stdoutIsTTY ?? process.stdout.isTTY) || !(options.stderrIsTTY ?? process.stderr.isTTY)) {
    return false;
  }
  const commandKey = options.commandPath.join(" ").trim();
  return !SUPPRESSED_COMMANDS.has(commandKey);
}

export async function collectCliNotices(options: CliNoticeOptions): Promise<string[]> {
  if (!shouldEmitCliNotices(options)) {
    return [];
  }

  const env = options.env ?? process.env;
  const statePath = options.statePath ?? resolveCliStatePath(env);
  if (!statePath) {
    return [];
  }

  const state = await readNoticeState(statePath);
  const nextState: CliNoticeState = { ...state };
  const notices: string[] = [];
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  if (!state.starPromptShown) {
    notices.push(`If SwarmVault is useful, star the repo: ${STAR_URL}`);
    nextState.starPromptShown = true;
  }

  const lastCheckMs = state.lastUpdateCheckAt ? Date.parse(state.lastUpdateCheckAt) : Number.NaN;
  const shouldCheckUpdates = !Number.isFinite(lastCheckMs) || nowMs - lastCheckMs >= NOTICE_CACHE_TTL_MS;
  if (shouldCheckUpdates) {
    const fetchLatestVersion = options.fetchLatestVersion ?? (() => fetchLatestCliVersion(env));
    const latestVersion = await fetchLatestVersion().catch(() => null);
    nextState.lastUpdateCheckAt = now.toISOString();
    if (latestVersion) {
      nextState.lastSeenLatestVersion = latestVersion;
      if (isVersionNewer(latestVersion, options.currentVersion)) {
        notices.unshift(
          `Update available: ${latestVersion} (current ${options.currentVersion}). Upgrade with: npm install -g ${NPM_PACKAGE}@latest`
        );
      }
    }
  }

  await writeNoticeState(statePath, nextState);
  return notices;
}

async function readNoticeState(statePath: string): Promise<CliNoticeState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as CliNoticeState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function writeNoticeState(statePath: string, state: CliNoticeState): Promise<void> {
  try {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Ignore state-write failures so command completion never fails because of notices.
  }
}

async function fetchLatestCliVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn("npm", ["view", NPM_PACKAGE, "version", "--json"], {
      env: {
        ...process.env,
        ...env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false"
      },
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    child.on("error", () => {
      finish(null);
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(raw) as string;
        finish(typeof parsed === "string" && parsed.trim() ? parsed.trim() : null);
      } catch {
        finish(raw.replace(/^"+|"+$/g, "").trim() || null);
      }
    });

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, NOTICE_TIMEOUT_MS);
  });
}

function isVersionNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function normalizeVersion(version: string): number[] {
  const match = version.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return [0];
  }
  return match.slice(1).map((segment) => Number.parseInt(segment ?? "0", 10) || 0);
}
