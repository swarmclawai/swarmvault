import fs from "node:fs/promises";
import path from "node:path";
import { defaultVaultSchema, loadVaultConfig } from "./config.js";
import { fileExists, sha256, toPosix } from "./utils.js";

export interface VaultSchema {
  path: string;
  content: string;
  hash: string;
}

export interface LoadedVaultSchemas {
  root: VaultSchema;
  projects: Record<string, VaultSchema>;
  effective: {
    global: VaultSchema;
    projects: Record<string, VaultSchema>;
  };
}

function normalizeSchemaContent(content: string): string {
  return content.trim() ? content.trim() : defaultVaultSchema().trim();
}

async function readSchemaFile(schemaPath: string, fallback = defaultVaultSchema()): Promise<VaultSchema> {
  const content = (await fileExists(schemaPath)) ? await fs.readFile(schemaPath, "utf8") : fallback;
  const normalized = normalizeSchemaContent(content);
  return {
    path: schemaPath,
    content: normalized,
    hash: sha256(normalized)
  };
}

function resolveProjectSchemaPath(rootDir: string, schemaPath: string): string {
  return path.resolve(rootDir, schemaPath);
}

export function composeVaultSchema(root: VaultSchema, projectSchemas: VaultSchema[] = []): VaultSchema {
  if (!projectSchemas.length) {
    return {
      path: root.path,
      content: root.content,
      hash: root.hash
    };
  }

  const content = [
    root.content,
    ...projectSchemas.map((schema) =>
      [
        `## Project Schema`,
        "",
        `Path: ${toPosix(path.relative(path.dirname(root.path), schema.path) || schema.path)}`,
        "",
        schema.content
      ].join("\n")
    )
  ].join("\n\n");

  return {
    path: [root.path, ...projectSchemas.map((schema) => schema.path)].join(" + "),
    content,
    hash: sha256(content)
  };
}

export function effectiveProjectIds(schemas: LoadedVaultSchemas): string[] {
  return Object.keys(schemas.effective.projects).sort((left, right) => left.localeCompare(right));
}

export function getEffectiveSchema(schemas: LoadedVaultSchemas, projectId?: string | null): VaultSchema {
  if (!projectId) {
    return schemas.effective.global;
  }
  return schemas.effective.projects[projectId] ?? schemas.effective.global;
}

export async function loadVaultSchemas(rootDir: string): Promise<LoadedVaultSchemas> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const root = await readSchemaFile(paths.schemaPath);
  const projects = Object.fromEntries(
    await Promise.all(
      Object.entries(config.projects ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(async ([projectId, project]) => {
          if (!project.schemaPath) {
            return [
              projectId,
              {
                path: "",
                content: "",
                hash: ""
              }
            ] as const;
          }
          return [projectId, await readSchemaFile(resolveProjectSchemaPath(rootDir, project.schemaPath), "")] as const;
        })
    )
  );

  const effectiveProjects = Object.fromEntries(
    Object.entries(projects).map(([projectId, schema]) => [
      projectId,
      schema.hash ? composeVaultSchema(root, [schema]) : composeVaultSchema(root)
    ])
  );

  return {
    root,
    projects,
    effective: {
      global: composeVaultSchema(root),
      projects: effectiveProjects
    }
  };
}

export async function loadVaultSchema(rootDir: string): Promise<VaultSchema> {
  return (await loadVaultSchemas(rootDir)).root;
}

export function schemaCategoryLabels(schema: VaultSchema): string[] {
  const lines = schema.content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Categories");
  if (start < 0) {
    return [];
  }
  const sectionLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    sectionLines.push(line);
  }
  return sectionLines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

export function buildSchemaPrompt(schema: VaultSchema, instruction: string): string {
  return [instruction, "", `Vault schema path: ${schema.path}`, "", "Vault schema instructions:", schema.content].join("\n");
}
