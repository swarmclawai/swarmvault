// Standalone OpenCode plugin. Bundled by tsup into dist/hooks/opencode.js
// and installed into user projects as `.opencode/plugins/swarmvault-graph-first.js`.
// Targets the Bun runtime OpenCode uses; TypeScript sees Bun via the
// minimal ambient declaration below so the engine typecheck can build
// this file without pulling in @types/bun.

import path from "node:path";

declare const Bun: {
  file(input: string): { arrayBuffer(): Promise<ArrayBuffer> };
};

const reportRelativePath = path.join("wiki", "graph", "report.md");

interface OpencodePluginContext {
  client?: {
    app?: {
      log?: (entry: { level: string; message: string }) => Promise<void> | void;
    };
  };
}

interface OpencodeSessionInput {
  session?: { cwd?: string };
}

interface OpencodeToolInput extends OpencodeSessionInput {
  args?: unknown;
  tool?: string;
}

export const name = "swarmvault-graph-first";

export default async function swarmvaultGraphFirst({ client }: OpencodePluginContext) {
  let reportSeen = false;

  async function hasReport(cwd: string): Promise<boolean> {
    try {
      await Bun.file(path.join(cwd, reportRelativePath)).arrayBuffer();
      return true;
    } catch {
      return false;
    }
  }

  async function note(message: string): Promise<void> {
    if (client?.app?.log) {
      await client.app.log({
        level: "info",
        message
      });
    }
  }

  return {
    async "session.created"(input: OpencodeSessionInput) {
      reportSeen = false;
      const cwd = input?.session?.cwd ?? process.cwd();
      if (await hasReport(cwd)) {
        await note("SwarmVault graph report exists. Read wiki/graph/report.md before broad workspace searching.");
      }
    },
    async "tool.execute.before"(input: OpencodeToolInput) {
      const cwd = input?.session?.cwd ?? process.cwd();
      if (!(await hasReport(cwd))) {
        return;
      }

      const argsText = JSON.stringify(input?.args ?? {});
      if (argsText.includes("wiki/graph/report.md")) {
        reportSeen = true;
        return;
      }

      if (!reportSeen && ["glob", "grep"].includes(String(input?.tool ?? ""))) {
        await note("SwarmVault graph report exists. Read wiki/graph/report.md before broad workspace searching.");
      }
    }
  };
}
