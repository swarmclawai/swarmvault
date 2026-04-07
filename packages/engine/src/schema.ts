import fs from "node:fs/promises";
import path from "node:path";
import { defaultVaultSchema, LEGACY_SCHEMA_FILENAME, loadVaultConfig, PRIMARY_SCHEMA_FILENAME } from "./config.js";
import { fileExists, sha256 } from "./utils.js";

export interface VaultSchema {
  path: string;
  content: string;
  hash: string;
  isLegacyPath: boolean;
}

export async function loadVaultSchema(rootDir: string): Promise<VaultSchema> {
  const { paths } = await loadVaultConfig(rootDir);
  const schemaPath = paths.schemaPath;
  const content = (await fileExists(schemaPath)) ? await fs.readFile(schemaPath, "utf8") : defaultVaultSchema();
  const normalized = content.trim() ? content.trim() : defaultVaultSchema().trim();

  return {
    path: schemaPath,
    content: normalized,
    hash: sha256(normalized),
    isLegacyPath: path.basename(schemaPath) === LEGACY_SCHEMA_FILENAME && path.basename(schemaPath) !== PRIMARY_SCHEMA_FILENAME
  };
}

export function buildSchemaPrompt(schema: VaultSchema, instruction: string): string {
  return [instruction, "", `Vault schema path: ${schema.path}`, "", "Vault schema instructions:", schema.content].join("\n");
}
