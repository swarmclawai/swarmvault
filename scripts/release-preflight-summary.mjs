import fs from "node:fs/promises";
import path from "node:path";

export function createPreflightSummary({
  version,
  repoRoot,
  webRoot,
  startedAt,
  finishedAt = new Date().toISOString(),
  gates = [],
  packageSmoke = {},
  artifacts = {}
}) {
  return {
    version,
    repoRoot,
    webRoot,
    startedAt,
    finishedAt,
    status: gates.some((gate) => gate.status === "failed") ? "failed" : "passed",
    gates,
    packageSmoke,
    artifacts
  };
}

export function formatPreflightSummaryMarkdown(summary) {
  const lines = [
    `# SwarmVault ${summary.version} Release Preflight`,
    "",
    `Status: ${summary.status}`,
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Duration | Detail |",
    "|---|---:|---:|---|"
  ];

  for (const gate of summary.gates) {
    const duration = typeof gate.durationMs === "number" ? `${gate.durationMs}ms` : "";
    const detail = gate.detail ? String(gate.detail).replace(/\n/g, " ") : "";
    lines.push(`| ${gate.label} | ${gate.status} | ${duration} | ${detail} |`);
  }

  lines.push("", "## Package Smoke", "");
  if (Array.isArray(summary.packageSmoke.installSpecs) && summary.packageSmoke.installSpecs.length) {
    lines.push("Install specs:");
    for (const installSpec of summary.packageSmoke.installSpecs) {
      lines.push(`- ${installSpec}`);
    }
  } else {
    lines.push("Install specs: not recorded");
  }
  lines.push(`Pack directory: ${summary.packageSmoke.packDir ?? "not created"}`);
  lines.push(`Pack directory kept: ${summary.packageSmoke.packDirKept ? "yes" : "no"}`);
  lines.push(`Browser smoke: ${summary.packageSmoke.browserSmoke ?? "not run"}`);
  lines.push(`OSS corpus: ${summary.packageSmoke.ossCorpus ?? "not run"}`);

  lines.push("", "## Artifacts", "");
  for (const [name, artifactPath] of Object.entries(summary.artifacts ?? {})) {
    lines.push(`- ${name}: ${artifactPath}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function writePreflightSummary(summary, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "summary.json");
  const markdownPath = path.join(outputDir, "summary.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, formatPreflightSummaryMarkdown(summary), "utf8");
  return { jsonPath, markdownPath };
}
