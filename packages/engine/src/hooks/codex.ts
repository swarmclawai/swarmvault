// Standalone Codex hook script. Bundled by tsup into
// dist/hooks/codex.js and installed into user projects as
// `.codex/hooks/swarmvault-graph-first.js`.

import {
  collectCandidatePaths,
  hasReport,
  hasSeenReport,
  isBroadSearchInput,
  isReportPath,
  markReportRead,
  REPORT_NOTE,
  readHookInput,
  resetSession,
  resolveInputCwd
} from "./marker-state.js";

const AGENT_KEY = "codex";

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function note(): { priority: "IMPORTANT"; message: string } {
  return {
    priority: "IMPORTANT",
    message: REPORT_NOTE
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  const input = await readHookInput();
  const cwd = resolveInputCwd(input);

  if (!(await hasReport(cwd))) {
    emit({});
    process.exit(0);
  }

  if (mode === "session-start") {
    await resetSession(cwd, AGENT_KEY);
    emit(note());
    process.exit(0);
  }

  if (collectCandidatePaths(input).some((value) => isReportPath(value, cwd))) {
    await markReportRead(cwd, AGENT_KEY);
    emit({});
    process.exit(0);
  }

  if (isBroadSearchInput(input) && !(await hasSeenReport(cwd, AGENT_KEY))) {
    emit(note());
    process.exit(0);
  }

  emit({});
}

await main();
