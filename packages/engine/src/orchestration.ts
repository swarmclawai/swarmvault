import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { loadVaultConfig } from "./config.js";
import { normalizeFindingSeverity } from "./findings.js";
import { createProvider } from "./providers/registry.js";
import type { OrchestrationRole, OrchestrationRoleConfig, OrchestrationRoleResult, RoleExecutorConfig } from "./types.js";

const orchestrationRoleResultSchema = z.object({
  summary: z.string().optional(),
  findings: z
    .array(
      z.object({
        severity: z.string().optional().default("info"),
        message: z.string().min(1),
        relatedPageIds: z.array(z.string()).optional(),
        relatedSourceIds: z.array(z.string()).optional(),
        suggestedQuery: z.string().optional()
      })
    )
    .default([]),
  questions: z.array(z.string().min(1)).default([]),
  proposals: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string().min(1),
        reason: z.string().min(1)
      })
    )
    .default([])
});

function emptyResult(role: OrchestrationRole): OrchestrationRoleResult {
  return { role, findings: [], questions: [], proposals: [] };
}

function heuristicRoleResult(role: OrchestrationRole, prompt: string): OrchestrationRoleResult {
  const base = emptyResult(role);
  switch (role) {
    case "research":
      return {
        ...base,
        questions: [`What evidence best strengthens this topic?`, `What contradicts the current vault position?`]
      };
    case "safety":
      return {
        ...base,
        findings: [
          {
            role,
            severity: "info",
            message: "Heuristic safety review completed without structured contradictions.",
            suggestedQuery: "What claims in this result need stronger source support?"
          }
        ]
      };
    case "audit":
      return {
        ...base,
        findings: [
          {
            role,
            severity: "info",
            message: "Heuristic audit review suggests validating citations against raw sources.",
            suggestedQuery: "Which raw sources most directly support this result?"
          }
        ]
      };
    case "context":
      return {
        ...base,
        summary: prompt.slice(0, 160)
      };
    default:
      return base;
  }
}

async function runProviderRole(
  rootDir: string,
  role: OrchestrationRole,
  roleConfig: OrchestrationRoleConfig,
  input: { system: string; prompt: string }
): Promise<OrchestrationRoleResult> {
  const { config } = await loadVaultConfig(rootDir);
  const providerConfig = config.providers[(roleConfig.executor as { provider: string }).provider];
  if (!providerConfig) {
    throw new Error(`Orchestration provider not found: ${(roleConfig.executor as { provider: string }).provider}`);
  }
  const provider = await createProvider((roleConfig.executor as { provider: string }).provider, providerConfig, rootDir);
  if (provider.type === "heuristic") {
    return heuristicRoleResult(role, input.prompt);
  }
  const result = await provider.generateStructured(
    {
      system: input.system,
      prompt: input.prompt
    },
    orchestrationRoleResultSchema
  );
  return {
    role,
    summary: result.summary,
    findings: result.findings.map((finding) => ({ role, ...finding, severity: normalizeFindingSeverity(finding.severity) })),
    questions: result.questions,
    proposals: result.proposals
  };
}

async function runCommandRole(
  rootDir: string,
  role: OrchestrationRole,
  executor: Extract<RoleExecutorConfig, { type: "command" }>,
  input: { system: string; prompt: string }
): Promise<OrchestrationRoleResult> {
  const [command, ...args] = executor.command;
  const cwd = executor.cwd ? path.resolve(rootDir, executor.cwd) : rootDir;
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...(executor.env ?? {})
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, executor.timeoutMs ?? 60_000);

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stdin.write(
    JSON.stringify(
      {
        role,
        system: input.system,
        prompt: input.prompt
      },
      null,
      2
    )
  );
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => {
    clearTimeout(timeout);
  });

  if (exitCode !== 0) {
    throw new Error(stderrChunks.length ? Buffer.concat(stderrChunks).toString("utf8") : `Role command failed with exit code ${exitCode}`);
  }

  const parsed = orchestrationRoleResultSchema.parse(JSON.parse(Buffer.concat(stdoutChunks).toString("utf8") || "{}"));
  return {
    role,
    summary: parsed.summary,
    findings: parsed.findings.map((finding) => ({ role, ...finding, severity: normalizeFindingSeverity(finding.severity) })),
    questions: parsed.questions,
    proposals: parsed.proposals
  };
}

async function runRole(
  rootDir: string,
  role: OrchestrationRole,
  roleConfig: OrchestrationRoleConfig,
  input: { system: string; prompt: string }
): Promise<OrchestrationRoleResult> {
  if (roleConfig.executor.type === "provider") {
    return runProviderRole(rootDir, role, roleConfig, input);
  }
  return runCommandRole(rootDir, role, roleConfig.executor, input);
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, maxParallel: number): Promise<T[]> {
  const limit = Math.max(1, maxParallel);
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await tasks[index]();
      }
    })
  );
  return results;
}

export async function runConfiguredRoles(
  rootDir: string,
  roles: OrchestrationRole[],
  input: {
    title: string;
    instructions: string;
    context: string;
  }
): Promise<OrchestrationRoleResult[]> {
  const { config } = await loadVaultConfig(rootDir);
  const roleConfigs = config.orchestration?.roles ?? {};
  const maxParallel = config.orchestration?.maxParallelRoles ?? 2;
  const selected = roles
    .map((role) => ({ role, config: roleConfigs[role] }))
    .filter((entry): entry is { role: OrchestrationRole; config: OrchestrationRoleConfig } => Boolean(entry.config));

  if (!selected.length) {
    return [];
  }

  return runWithConcurrency(
    selected.map(
      (entry) => () =>
        runRole(rootDir, entry.role, entry.config, {
          system: `You are the ${entry.role} role in SwarmVault orchestration. Return JSON only.`,
          prompt: [`Title: ${input.title}`, "", input.instructions, "", input.context].join("\n")
        })
    ),
    maxParallel
  );
}

export function summarizeRoleQuestions(results: OrchestrationRoleResult[]): string[] {
  return [...new Set(results.flatMap((result) => result.questions).filter(Boolean))];
}
