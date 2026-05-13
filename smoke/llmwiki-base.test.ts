// LLM Wiki base smoke harness.
//
// Exercises the documented happy path of the SwarmVault CLI as the gate for
// "this fork still works": demo --no-serve creates a temp vault, next --json
// reports a compiled vault with positive counts, doctor --json returns an
// acceptable status, and graph serve answers / and /api/bookmarklet over HTTP.
//
// Spawn pattern mirrors packages/engine/test/vault.test.ts (direct
// `spawn("node", [CLI_ENTRY, ...args])`) so Windows .cmd shim quoting and PATH
// resolution never enter the picture. The CLI must be built (`pnpm build`)
// before this test runs - packages/cli/dist is gitignored.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const VIEWER_PORT = 4123;
const READY_REGEX = /Graph viewer running at http:\/\/localhost:(\d+)/;

const tempDirs: string[] = [];
const liveChildren = new Set<ChildProcess>();

afterAll(async () => {
  for (const child of liveChildren) {
    try {
      child.kill();
    } catch {}
  }
  liveChildren.clear();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {}))
  );
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error(`runCli(${args.join(" ")}) timed out after ${timeoutMs}ms; stderr=${stderr}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ stdout, stderr, code });
    });
  });
}

interface ServerHandle {
  child: ChildProcess;
  port: number;
  stop: () => Promise<void>;
}

function spawnServer(
  args: string[],
  opts: { cwd: string; readyRegex: RegExp; timeoutMs?: number }
): Promise<ServerHandle> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    liveChildren.add(child);
    let stdoutBuf = "";
    let settled = false;
    const stop = async (): Promise<void> => {
      if (child.exitCode !== null) {
        liveChildren.delete(child);
        return;
      }
      return new Promise<void>((stopResolve) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 3_000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          liveChildren.delete(child);
          stopResolve();
        });
        try {
          child.kill();
        } catch {
          clearTimeout(killTimer);
          liveChildren.delete(child);
          stopResolve();
        }
      });
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await stop();
      reject(new Error(`spawnServer(${args.join(" ")}) ready-timeout after ${timeoutMs}ms; stdout=${stdoutBuf}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const m = stdoutBuf.match(opts.readyRegex);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        const port = Number(m[1]);
        resolve({ child, port, stop });
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(new Error(`spawnServer(${args.join(" ")}) exited before ready (code ${code}); stdout=${stdoutBuf}`));
    });
  });
}

describe("LLM Wiki base smoke", () => {
  let demoVaultPath: string;

  it(
    "demo --no-serve creates a temp vault",
    async () => {
      const { stdout, stderr, code } = await runCli(["demo", "--no-serve"]);
      expect(code, `demo --no-serve stderr: ${stderr}`).toBe(0);
      const match = stdout.match(/Vault location:\s+([^\r\n]+)/);
      expect(match, `stdout did not contain "Vault location:" line. stdout=${stdout}`).not.toBeNull();
      demoVaultPath = match![1].trim();
      await fs.access(demoVaultPath);
      tempDirs.push(demoVaultPath);
    },
    120_000
  );

  it(
    "next --json reports compiled with positive counts",
    async () => {
      expect(demoVaultPath, "demo vault path missing - prior test must have populated it").toBeTruthy();
      const { stdout, stderr, code } = await runCli(["next", "--json"], { cwd: demoVaultPath });
      expect(code, `next --json stderr: ${stderr}`).toBe(0);
      const report = JSON.parse(stdout);
      // Brief said "pageCount" / "nodeCount" - real fields are counts.pages / counts.nodes.
      expect(report.status).toBe("compiled");
      expect(report.counts?.pages).toBeGreaterThan(0);
      expect(report.counts?.nodes).toBeGreaterThan(0);
    },
    60_000
  );

  it(
    "doctor --json returns ok or warning",
    async () => {
      expect(demoVaultPath).toBeTruthy();
      const { stdout, stderr, code } = await runCli(["doctor", "--json"], { cwd: demoVaultPath });
      expect(code, `doctor --json stderr: ${stderr}`).toBe(0);
      const report = JSON.parse(stdout);
      // Brief said "health" - real field is "status" with "ok" | "warning" | "error". Warning is acceptable.
      expect(["ok", "warning"]).toContain(report.status);
    },
    60_000
  );

  it(
    "graph serve answers / and /api/bookmarklet",
    async () => {
      expect(demoVaultPath).toBeTruthy();
      const attempt = async (): Promise<void> => {
        const server = await spawnServer(["graph", "serve"], {
          cwd: demoVaultPath,
          readyRegex: READY_REGEX
        });
        const port = server.port || VIEWER_PORT;
        try {
          const rootResp = await fetch(`http://localhost:${port}/`, {
            signal: AbortSignal.timeout(5_000)
          });
          expect(rootResp.status).toBe(200);
          const bmResp = await fetch(`http://localhost:${port}/api/bookmarklet`, {
            signal: AbortSignal.timeout(5_000)
          });
          expect(bmResp.status).toBe(200);
        } finally {
          await server.stop();
        }
      };
      // Single retry per brief: if graph viewer flakes ONCE, retry ONCE then STOP.
      try {
        await attempt();
      } catch (err) {
        await attempt();
      }
    },
    90_000
  );
});
