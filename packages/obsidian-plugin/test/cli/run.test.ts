import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CliRunner } from "../../src/cli/run";
import { CliInvocationError, CliNotFoundError } from "../../src/types";

interface FakeChildOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  spawnError?: NodeJS.ErrnoException;
  closeDelayMs?: number;
}

class FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  killed = false;
  exitCode: number | null = null;

  constructor(readonly opts: FakeChildOptions) {
    super();
    this.stdout = Readable.from(chunks(opts.stdout ?? ""));
    this.stderr = Readable.from(chunks(opts.stderr ?? ""));
    const delay = opts.closeDelayMs ?? 0;
    setTimeout(() => {
      this.exitCode = opts.exitCode ?? 0;
      this.emit("close", this.exitCode);
    }, delay);
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.exitCode = this.exitCode ?? 143;
    this.emit("close", this.exitCode);
    return true;
  }
}

function chunks(text: string): string[] {
  if (!text) return [];
  // Split mid-line to exercise the line splitter buffer.
  return [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))];
}

function makeSpawn(opts: FakeChildOptions): typeof import("node:child_process").spawn {
  return ((binary: string, _args: readonly string[], _options?: unknown) => {
    if (opts.spawnError) {
      const err = opts.spawnError;
      const child = new FakeChild({ exitCode: 0 });
      queueMicrotask(() => child.emit("error", err));
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }
    void binary;
    return new FakeChild(opts) as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as unknown as typeof import("node:child_process").spawn;
}

describe("CliRunner.invoke", () => {
  it("returns parsed JSON and raw streams on success", async () => {
    const stdout = '{"version":"0.7.28"}\n';
    const stderr = "probing cli...\n";
    const runner = new CliRunner({ spawn: makeSpawn({ stdout, stderr }), now: () => 1000 });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const result = await runner.invoke<{ version: string }>("swarmvault", {
      args: ["--version", "--json"],
      onStdoutLine: (l) => stdoutLines.push(l),
      onStderrLine: (l) => stderrLines.push(l)
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({ version: "0.7.28" });
    expect(result.rawStdout).toBe(stdout);
    expect(result.rawStderr).toBe(stderr);
    expect(stdoutLines).toEqual(['{"version":"0.7.28"}']);
    expect(stderrLines).toEqual(["probing cli..."]);
  });

  it("throws CliInvocationError with exit code and streams on non-zero exit", async () => {
    const runner = new CliRunner({
      spawn: makeSpawn({ stdout: '{"error":"nope"}', stderr: "boom\n", exitCode: 2 })
    });
    await expect(runner.invoke("swarmvault", { args: ["compile"] })).rejects.toMatchObject({
      name: "CliInvocationError",
      exitCode: 2,
      rawStderr: "boom\n"
    });
    await expect(runner.invoke("swarmvault", { args: ["compile"] })).rejects.toBeInstanceOf(CliInvocationError);
  });

  it("throws CliNotFoundError when spawn reports ENOENT", async () => {
    const enoent = Object.assign(new Error("not found"), { code: "ENOENT" as const });
    const runner = new CliRunner({
      spawn: makeSpawn({ spawnError: enoent as NodeJS.ErrnoException })
    });
    await expect(runner.invoke("/does/not/exist", { args: ["--version"] })).rejects.toBeInstanceOf(CliNotFoundError);
  });

  it("returns null json when stdout is empty", async () => {
    const runner = new CliRunner({ spawn: makeSpawn({ stdout: "", stderr: "" }) });
    const result = await runner.invoke("swarmvault", { args: ["--version"] });
    expect(result.json).toBeNull();
  });

  it("extracts JSON from the last line when stdout has preamble", async () => {
    const runner = new CliRunner({
      spawn: makeSpawn({ stdout: 'hello\n{"version":"0.7.28"}\n', stderr: "" })
    });
    const result = await runner.invoke<{ version: string }>("swarmvault", {
      args: ["--version"]
    });
    expect(result.json).toEqual({ version: "0.7.28" });
  });

  it("aborts running command on signal", async () => {
    const controller = new AbortController();
    const runner = new CliRunner({
      spawn: makeSpawn({ stdout: "", stderr: "", exitCode: 143, closeDelayMs: 500 })
    });
    const promise = runner.invoke("swarmvault", {
      args: ["watch"],
      signal: controller.signal
    });
    queueMicrotask(() => controller.abort());
    await expect(promise).rejects.toBeInstanceOf(CliInvocationError);
  });
});

describe("CliRunner line streaming", () => {
  it("splits multi-line stdout into separate callbacks", async () => {
    const runner = new CliRunner({
      spawn: makeSpawn({ stdout: "a\nb\nc", stderr: "" })
    });
    const lines: string[] = [];
    await runner.invoke("swarmvault", { args: [], onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(["a", "b", "c"]);
  });
});

// Keep vi import referenced to avoid unused-import errors in strict test envs.
void vi;
