// Standalone Claude Code hook script. Bundled by tsup into
// dist/hooks/claude.js and installed into user projects as
// `.claude/hooks/swarmvault-graph-first.js`. Must not import from engine
// code — tsup inlines only the shared marker-state helpers.

import {
  collectCandidatePaths,
  hasReport,
  hasSeenReport,
  isBroadSearchTool,
  isReportPath,
  markReportRead,
  REPORT_NOTE,
  readHookInput,
  resetSession,
  resolveInputCwd,
  resolveToolName
} from "./marker-state.js";

const AGENT_KEY = "claude";

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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
    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: REPORT_NOTE
      }
    });
    process.exit(0);
  }

  const toolName = resolveToolName(input);
  if (collectCandidatePaths(input).some((value) => isReportPath(value, cwd))) {
    await markReportRead(cwd, AGENT_KEY);
    emit({});
    process.exit(0);
  }

  if (isBroadSearchTool(toolName) && !(await hasSeenReport(cwd, AGENT_KEY))) {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: REPORT_NOTE
      }
    });
    process.exit(0);
  }

  emit({});
}

await main();
