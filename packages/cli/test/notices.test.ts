import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCliNotices, collectHeuristicProviderNotice, shouldEmitCliNotices } from "../src/notices.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("shouldEmitCliNotices", () => {
  it("suppresses notices for automation and long-running commands", () => {
    expect(
      shouldEmitCliNotices({
        commandPath: ["compile"],
        currentVersion: "0.1.25",
        json: true,
        stderrIsTTY: true,
        stdoutIsTTY: true
      })
    ).toBe(false);
    expect(
      shouldEmitCliNotices({
        commandPath: ["compile"],
        currentVersion: "0.1.25",
        env: { CI: "1" },
        stderrIsTTY: true,
        stdoutIsTTY: true
      })
    ).toBe(false);
    expect(
      shouldEmitCliNotices({
        commandPath: ["graph", "serve"],
        currentVersion: "0.1.25",
        stderrIsTTY: true,
        stdoutIsTTY: true
      })
    ).toBe(false);
    expect(
      shouldEmitCliNotices({
        commandPath: ["compile"],
        currentVersion: "0.1.25",
        stderrIsTTY: false,
        stdoutIsTTY: true
      })
    ).toBe(false);
  });
});

describe("collectCliNotices", () => {
  it("shows the one-time star prompt on the first interactive run", async () => {
    const { statePath } = await createStatePath();
    const fetchLatestVersion = vi.fn().mockResolvedValue("0.1.25");

    const notices = await collectCliNotices({
      commandPath: ["compile"],
      currentVersion: "0.1.25",
      env: {},
      fetchLatestVersion,
      now: new Date("2026-04-08T12:00:00.000Z"),
      statePath,
      stderrIsTTY: true,
      stdoutIsTTY: true
    });

    expect(notices).toEqual(["If SwarmVault is useful, star the repo: https://github.com/swarmclawai/swarmvault"]);
    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      lastSeenLatestVersion?: string;
      starPromptShown?: boolean;
    };
    expect(persisted.starPromptShown).toBe(true);
    expect(persisted.lastSeenLatestVersion).toBe("0.1.25");
  });

  it("shows upgrade guidance for a newer published version and caches the check", async () => {
    const { statePath } = await createStatePath();
    const fetchLatestVersion = vi.fn().mockResolvedValue("0.1.26");
    const baseOptions = {
      commandPath: ["query"],
      currentVersion: "0.1.25",
      env: {},
      fetchLatestVersion,
      statePath,
      stderrIsTTY: true,
      stdoutIsTTY: true
    } as const;

    const first = await collectCliNotices({
      ...baseOptions,
      now: new Date("2026-04-08T12:00:00.000Z")
    });
    expect(first).toEqual([
      "Update available: 0.1.26 (current 0.1.25). Upgrade with: npm install -g @swarmvaultai/cli@latest",
      "If SwarmVault is useful, star the repo: https://github.com/swarmclawai/swarmvault"
    ]);

    const second = await collectCliNotices({
      ...baseOptions,
      now: new Date("2026-04-08T12:30:00.000Z")
    });
    expect(second).toEqual([]);
    expect(fetchLatestVersion).toHaveBeenCalledTimes(1);
  });

  it("supports disabling notices completely", async () => {
    const { statePath } = await createStatePath();
    const fetchLatestVersion = vi.fn().mockResolvedValue("0.1.26");

    const notices = await collectCliNotices({
      commandPath: ["compile"],
      currentVersion: "0.1.25",
      env: { SWARMVAULT_NO_NOTICES: "1" },
      fetchLatestVersion,
      statePath,
      stderrIsTTY: true,
      stdoutIsTTY: true
    });

    expect(notices).toEqual([]);
    expect(fetchLatestVersion).not.toHaveBeenCalled();
  });
});

describe("collectHeuristicProviderNotice", () => {
  it("emits a notice recommending ollama gemma4 and throttles to one per week", async () => {
    const { statePath } = await createStatePath();
    const baseOptions = {
      env: {},
      statePath,
      stderrIsTTY: true,
      stdoutIsTTY: true
    } as const;

    const first = await collectHeuristicProviderNotice({
      ...baseOptions,
      now: new Date("2026-04-08T12:00:00.000Z")
    });
    expect(first).toBeTruthy();
    expect(first).toContain("ollama pull gemma4");
    expect(first).toContain("heuristic analyzer");

    const second = await collectHeuristicProviderNotice({
      ...baseOptions,
      now: new Date("2026-04-09T12:00:00.000Z")
    });
    expect(second).toBeNull();

    const third = await collectHeuristicProviderNotice({
      ...baseOptions,
      now: new Date("2026-04-16T13:00:00.000Z")
    });
    expect(third).toBeTruthy();
  });

  it("suppresses the heuristic notice in json, CI, and non-tty modes", async () => {
    const { statePath } = await createStatePath();
    const jsonResult = await collectHeuristicProviderNotice({
      env: {},
      statePath,
      stderrIsTTY: true,
      stdoutIsTTY: true,
      json: true
    });
    expect(jsonResult).toBeNull();

    const ciResult = await collectHeuristicProviderNotice({
      env: { CI: "1" },
      statePath,
      stderrIsTTY: true,
      stdoutIsTTY: true
    });
    expect(ciResult).toBeNull();

    const nonTtyResult = await collectHeuristicProviderNotice({
      env: {},
      statePath,
      stderrIsTTY: false,
      stdoutIsTTY: true
    });
    expect(nonTtyResult).toBeNull();
  });

  it("honors SWARMVAULT_NO_NOTICES", async () => {
    const { statePath } = await createStatePath();
    const result = await collectHeuristicProviderNotice({
      env: { SWARMVAULT_NO_NOTICES: "1" },
      statePath,
      stderrIsTTY: true,
      stdoutIsTTY: true
    });
    expect(result).toBeNull();
  });
});

async function createStatePath(): Promise<{ statePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "swarmvault-cli-notices-"));
  tempDirs.push(dir);
  return { statePath: path.join(dir, "cli-state.json") };
}
