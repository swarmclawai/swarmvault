import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import YAML from "yaml";
import { analyzeTreeSitterCode } from "./code-tree-sitter.js";
import type {
  CodeAnalysis,
  CodeDiagnostic,
  CodeImport,
  CodeIndexArtifact,
  CodeIndexEntry,
  CodeLanguage,
  CodeSymbol,
  CodeSymbolKind,
  SourceAnalysis,
  SourceClaim,
  SourceManifest,
  SourceRationale
} from "./types.js";
import { normalizeWhitespace, slugify, toPosix, truncate, uniqueBy } from "./utils.js";

type DraftCodeSymbol = {
  name: string;
  kind: CodeSymbolKind;
  signature: string;
  exported: boolean;
  callNames: string[];
  extendsNames: string[];
  implementsNames: string[];
  bodyText?: string;
};

type CodeLanguageDetectionOptions = {
  content?: string;
  executable?: boolean;
};

function scriptKindFor(language: CodeLanguage): ts.ScriptKind {
  switch (language) {
    case "typescript":
      return ts.ScriptKind.TS;
    case "tsx":
      return ts.ScriptKind.TSX;
    case "jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith(".");
}

function isLocalIncludeSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("/");
}

function bashSpecifierLooksLocal(specifier: string): boolean {
  return isLocalIncludeSpecifier(specifier) || /\.(?:sh|bash|zsh)$/i.test(specifier);
}

function dartSpecifierLooksLocal(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    (!specifier.startsWith("package:") && !specifier.includes(":") && specifier.endsWith(".dart"))
  );
}

function interpreterFromShebang(content: string | undefined): string | undefined {
  if (!content?.startsWith("#!")) {
    return undefined;
  }
  const firstLine = content.split(/\r?\n/, 1)[0]?.slice(2).trim() ?? "";
  if (!firstLine) {
    return undefined;
  }
  const parts = firstLine.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const basename = (value: string) => path.posix.basename(value.trim());
  if (basename(parts[0] ?? "") === "env") {
    const interpreter = parts.slice(1).find((part) => !part.startsWith("-"));
    return interpreter ? basename(interpreter) : undefined;
  }
  return basename(parts[0] ?? "");
}

function languageFromInterpreter(interpreter: string | undefined): CodeLanguage | undefined {
  switch (interpreter) {
    case "sh":
    case "bash":
    case "zsh":
    case "dash":
    case "ksh":
    case "ash":
      return "bash";
    case "node":
    case "nodejs":
      return "javascript";
    case "python":
    case "python2":
    case "python3":
      return "python";
    case "ruby":
      return "ruby";
    case "php":
      return "php";
    case "lua":
      return "lua";
    default:
      return undefined;
  }
}

function formatDiagnosticCategory(category: ts.DiagnosticCategory): CodeDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}

function declarationSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
  const sourceText = sourceFile.getFullText();

  if (ts.isFunctionDeclaration(node) && node.body) {
    return truncate(normalizeWhitespace(sourceText.slice(node.getStart(sourceFile), node.body.getStart(sourceFile)).trim()), 180);
  }

  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    const membersPos = node.members.pos;
    return truncate(
      normalizeWhitespace(
        sourceText
          .slice(node.getStart(sourceFile), membersPos)
          .replace(/\{\s*$/, "")
          .trim()
      ),
      180
    );
  }

  return truncate(normalizeWhitespace(node.getText(sourceFile)), 180);
}

function importSpecifierText(specifier: ts.ImportSpecifier): string {
  return specifier.propertyName ? `${specifier.propertyName.text} as ${specifier.name.text}` : specifier.name.text;
}

function exportSpecifierText(specifier: ts.ExportSpecifier): string {
  return specifier.propertyName ? `${specifier.propertyName.text} as ${specifier.name.text}` : specifier.name.text;
}

function collectCallNames(root: ts.Node | undefined, availableNames: Set<string>, selfName?: string): string[] {
  if (!root) {
    return [];
  }

  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && availableNames.has(node.expression.text)) {
      if (node.expression.text !== selfName) {
        names.push(node.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(root);
  return uniqueBy(names, (name) => name);
}

function collectCallNamesFromText(text: string | undefined, availableNames: Set<string>, selfName?: string): string[] {
  if (!text) {
    return [];
  }

  const names: string[] = [];
  for (const name of availableNames) {
    if (name === selfName) {
      continue;
    }
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g");
    if (pattern.test(text)) {
      names.push(name);
    }
  }
  return uniqueBy(names, (name) => name);
}

function heritageNames(
  clauses: ts.NodeArray<ts.HeritageClause> | undefined,
  token: ts.SyntaxKind.ExtendsKeyword | ts.SyntaxKind.ImplementsKeyword
): string[] {
  return uniqueBy(
    (clauses ?? [])
      .filter((clause) => clause.token === token)
      .flatMap((clause) =>
        clause.types.map((typeNode) => {
          if (ts.isIdentifier(typeNode.expression)) {
            return typeNode.expression.text;
          }
          if (ts.isPropertyAccessExpression(typeNode.expression)) {
            return typeNode.expression.getText();
          }
          return typeNode.getText();
        })
      ),
    (name) => name
  );
}

function isNodeExported(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some(
          (modifier: ts.ModifierLike) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
        )
  );
}

function makeSymbolId(scope: string, name: string, seen: Map<string, number>): string {
  const base = slugify(name);
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return `symbol:${scope}:${count === 1 ? base : `${base}-${count}`}`;
}

function summarizeModule(manifest: SourceManifest, code: CodeAnalysis): string {
  const localImports = code.imports.filter((item) => !item.isExternal && !item.reExport).length;
  const externalImports = code.imports.filter((item) => item.isExternal).length;
  const exportedCount = code.symbols.filter((symbol) => symbol.exported).length;
  const parts = [`${code.language} module`, `defining ${code.symbols.length} top-level symbol(s)`, `exporting ${exportedCount} symbol(s)`];

  if (localImports > 0) {
    parts.push(`importing ${localImports} local module(s)`);
  }
  if (externalImports > 0) {
    parts.push(`depending on ${externalImports} external package import(s)`);
  }
  if (code.diagnostics.length > 0) {
    parts.push(`with ${code.diagnostics.length} parser diagnostic(s)`);
  }

  return `${manifest.title} is a ${parts.join(", ")}.`;
}

function codeClaims(manifest: SourceManifest, code: CodeAnalysis): SourceClaim[] {
  const claims: Array<Omit<SourceClaim, "id">> = [];

  if (code.exports.length > 0) {
    claims.push({
      text: `${manifest.title} exports ${code.exports.slice(0, 4).join(", ")}${code.exports.length > 4 ? ", and more" : ""}.`,
      confidence: 1,
      status: "extracted",
      polarity: "neutral",
      citation: manifest.sourceId
    });
  }

  if (code.symbols.length > 0) {
    claims.push({
      text: `${manifest.title} defines ${code.symbols
        .slice(0, 5)
        .map((symbol) => symbol.name)
        .join(", ")}${code.symbols.length > 5 ? ", and more" : ""}.`,
      confidence: 1,
      status: "extracted",
      polarity: "neutral",
      citation: manifest.sourceId
    });
  }

  if (code.imports.length > 0) {
    claims.push({
      text: `${manifest.title} imports ${code.imports
        .slice(0, 4)
        .map((item) => item.specifier)
        .join(", ")}${code.imports.length > 4 ? ", and more" : ""}.`,
      confidence: 1,
      status: "extracted",
      polarity: "neutral",
      citation: manifest.sourceId
    });
  }

  if (code.diagnostics.length > 0) {
    claims.push({
      text: `${manifest.title} has ${code.diagnostics.length} parser diagnostic(s) that should be reviewed before trusting the module summary.`,
      confidence: 1,
      status: "extracted",
      polarity: "negative",
      citation: manifest.sourceId
    });
  }

  return claims.slice(0, 4).map((claim, index) => ({
    id: `claim:${manifest.sourceId}:${index + 1}`,
    ...claim
  }));
}

function codeQuestions(manifest: SourceManifest, code: CodeAnalysis): string[] {
  const questions = [
    code.exports.length > 0 ? `Which downstream pages should explain how ${manifest.title} exports are consumed?` : "",
    code.imports.some((item) => !item.isExternal) ? `How does ${manifest.title} coordinate with its imported local modules?` : "",
    code.dependencies[0] ? `Why does ${manifest.title} depend on ${code.dependencies[0]}?` : "",
    `What broader responsibility does ${manifest.title} serve in the codebase?`
  ].filter(Boolean);

  return uniqueBy(questions, (question) => question).slice(0, 4);
}

function resolveVariableKind(statement: ts.VariableStatement): CodeSymbolKind {
  return statement.declarationList.flags & ts.NodeFlags.Const ? "variable" : "variable";
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function leadingIndent(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].replace(/\t/g, "    ").length : 0;
}

function normalizeSymbolReference(value: string): string {
  const withoutGenerics = value.replace(/<[^>]*>/g, "");
  const withoutDecorators = withoutGenerics.replace(/['"&*()[\]{}]/g, " ");
  const trimmed = withoutDecorators.trim();
  const lastSegment = trimmed.split(/::|\./).filter(Boolean).at(-1) ?? trimmed;
  return lastSegment.replace(/[,:;]+$/g, "").trim();
}

function singleLineSignature(line: string): string {
  return truncate(
    normalizeWhitespace(
      line
        .replace(/\{\s*$/, "")
        .replace(/:\s*$/, ":")
        .trim()
    ),
    180
  );
}

function buildDiagnostic(
  code: number,
  message: string,
  line: number,
  column = 1,
  category: CodeDiagnostic["category"] = "warning"
): CodeDiagnostic {
  return { code, category, message, line, column };
}

const RATIONALE_MARKERS = ["NOTE:", "IMPORTANT:", "HACK:", "WHY:", "RATIONALE:"];

function stripKnownCommentPrefix(line: string): string {
  let next = line.trim();
  for (const prefix of ["/**", "/*", "*/", "//", "#", "*"]) {
    if (next.startsWith(prefix)) {
      next = next.slice(prefix.length).trimStart();
    }
  }
  return next;
}

function cleanCommentText(value: string): string {
  return normalizeWhitespace(
    value
      .split(/\r?\n/)
      .map((line) => stripKnownCommentPrefix(line))
      .join("\n")
      .trim()
  );
}

function rationaleKindFromText(text: string): SourceRationale["kind"] {
  const upper = text.toUpperCase();
  return RATIONALE_MARKERS.some((marker) => upper.startsWith(marker)) ? "marker" : "comment";
}

function normalizeRationaleText(value: string): string {
  let next = normalizeWhitespace(value.trim());
  const upper = next.toUpperCase();
  for (const marker of RATIONALE_MARKERS) {
    if (upper.startsWith(marker)) {
      next = next.slice(marker.length).trimStart();
      break;
    }
  }
  return next;
}

function isLikelyRationaleText(value: string): boolean {
  if (value.length < 20) {
    return false;
  }
  const upper = value.toUpperCase();
  if (RATIONALE_MARKERS.some((marker) => upper.startsWith(marker))) {
    return true;
  }
  const lower = value.toLowerCase();
  return ["why", "because", "tradeoff", "important", "avoid", "workaround", "reason", "so that", "in order to"].some((needle) =>
    lower.includes(needle)
  );
}

function makeRationale(
  manifest: SourceManifest,
  index: number,
  text: string,
  kind: SourceRationale["kind"],
  symbolName?: string
): SourceRationale | null {
  const normalized = normalizeRationaleText(cleanCommentText(text));
  if (!isLikelyRationaleText(normalized)) {
    return null;
  }
  return {
    id: `rationale:${manifest.sourceId}:${index}`,
    text: truncate(normalized, 280),
    citation: manifest.sourceId,
    kind,
    symbolName
  };
}

function stripCodeExtension(filePath: string): string {
  return filePath.replace(
    /\.(?:[cm]?jsx?|tsx?|mts|cts|sh|bash|zsh|py|go|rs|java|kt|kts|scala|sc|dart|lua|zig|cs|php|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i,
    ""
  );
}

function manifestModuleName(manifest: SourceManifest, language: CodeLanguage): string | undefined {
  const repoPath = manifest.repoRelativePath ?? path.basename(manifest.originalPath ?? manifest.storedPath);
  const normalized = toPosix(stripCodeExtension(repoPath)).replace(/^\.\/+/, "");
  if (!normalized) {
    return undefined;
  }
  if (language === "python") {
    const dotted = normalized
      .replace(/\/__init__$/i, "")
      .replace(/\//g, ".")
      .replace(/^src\./, "");
    return dotted || path.posix.basename(normalized);
  }
  return normalized.endsWith("/index") ? normalized.slice(0, -"/index".length) || path.posix.basename(normalized) : normalized;
}

function finalizeCodeAnalysis(
  manifest: SourceManifest,
  language: CodeLanguage,
  imports: CodeImport[],
  draftSymbols: DraftCodeSymbol[],
  exportLabels: string[],
  diagnostics: CodeDiagnostic[],
  metadata?: { moduleName?: string; namespace?: string }
): CodeAnalysis {
  const topLevelNames = new Set(draftSymbols.map((symbol) => symbol.name));
  for (const symbol of draftSymbols) {
    if (symbol.callNames.length === 0 && symbol.bodyText) {
      symbol.callNames = collectCallNamesFromText(symbol.bodyText, topLevelNames, symbol.name);
    }
  }

  const seenSymbolIds = new Map<string, number>();
  const symbolScope = metadata?.namespace ? `ns:${slugify(metadata.namespace)}` : manifest.sourceId;
  const symbols: CodeSymbol[] = draftSymbols.map((symbol) => ({
    id: makeSymbolId(symbolScope, symbol.name, seenSymbolIds),
    name: symbol.name,
    kind: symbol.kind,
    signature: symbol.signature,
    exported: symbol.exported,
    calls: uniqueBy(symbol.callNames, (name) => name),
    extends: uniqueBy(symbol.extendsNames.map((name) => normalizeSymbolReference(name)).filter(Boolean), (name) => name),
    implements: uniqueBy(symbol.implementsNames.map((name) => normalizeSymbolReference(name)).filter(Boolean), (name) => name)
  }));

  return {
    moduleId: `module:${manifest.sourceId}`,
    language,
    moduleName: metadata?.moduleName ?? manifestModuleName(manifest, language),
    namespace: metadata?.namespace,
    imports,
    dependencies: uniqueBy(
      imports.filter((item) => item.isExternal).map((item) => item.specifier),
      (specifier) => specifier
    ),
    symbols,
    exports: uniqueBy([...symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name), ...exportLabels], (label) => label),
    diagnostics
  };
}

function collectPythonBlock(lines: string[], startIndex: number): string {
  const startIndent = leadingIndent(lines[startIndex] ?? "");
  const parts: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      parts.push(line);
      continue;
    }
    if (leadingIndent(line) <= startIndent) {
      break;
    }
    parts.push(line);
  }
  return parts.join("\n");
}

function parsePythonImportList(value: string): Array<{ specifier: string; alias?: string }> {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [rawSpecifier, rawAlias] = item.split(/\s+as\s+/i);
      return {
        specifier: rawSpecifier.trim(),
        alias: rawAlias?.trim()
      };
    });
}

function parsePythonAllExportList(value: string): string[] {
  const match = value.match(/\[(.*)\]/);
  if (!match) {
    return [];
  }
  return uniqueBy(
    match[1]
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean),
    (item) => item
  );
}

function _analyzePythonCode(manifest: SourceManifest, content: string): CodeAnalysis {
  const lines = splitLines(content);
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const diagnostics: CodeDiagnostic[] = [];
  let explicitExports: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || leadingIndent(rawLine) > 0) {
      continue;
    }

    const importMatch = trimmed.match(/^import\s+(.+)$/);
    if (importMatch) {
      for (const item of parsePythonImportList(importMatch[1])) {
        imports.push({
          specifier: item.specifier,
          importedSymbols: [],
          namespaceImport: item.alias,
          isExternal: !isRelativeSpecifier(item.specifier),
          reExport: false
        });
      }
      continue;
    }

    const fromImportMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
    if (fromImportMatch) {
      const importedSymbols = fromImportMatch[2]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      imports.push({
        specifier: fromImportMatch[1],
        importedSymbols,
        isExternal: !isRelativeSpecifier(fromImportMatch[1]),
        reExport: false
      });
      continue;
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const baseNames = classMatch[2]
        ? classMatch[2]
            .split(",")
            .map((item) => normalizeSymbolReference(item))
            .filter(Boolean)
        : [];
      draftSymbols.push({
        name: classMatch[1],
        kind: "class",
        signature: singleLineSignature(trimmed),
        exported: !classMatch[1].startsWith("_"),
        callNames: [],
        extendsNames: baseNames,
        implementsNames: [],
        bodyText: collectPythonBlock(lines, index)
      });
      continue;
    }
    if (trimmed.startsWith("class ")) {
      diagnostics.push(buildDiagnostic(1001, "Python class declaration is missing a trailing colon.", index + 1));
      continue;
    }

    const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) {
      draftSymbols.push({
        name: functionMatch[1],
        kind: "function",
        signature: singleLineSignature(trimmed),
        exported: !functionMatch[1].startsWith("_"),
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: collectPythonBlock(lines, index)
      });
      continue;
    }
    if (trimmed.startsWith("def ") || trimmed.startsWith("async def ")) {
      diagnostics.push(buildDiagnostic(1002, "Python function declaration is missing a trailing colon.", index + 1));
      continue;
    }

    const allMatch = trimmed.match(/^__all__\s*=\s*\[(.*)\]\s*$/);
    if (allMatch) {
      explicitExports = parsePythonAllExportList(trimmed);
      continue;
    }

    const variableMatch = trimmed.match(/^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(.+)$/);
    if (variableMatch && !["True", "False", "None"].includes(variableMatch[1])) {
      draftSymbols.push({
        name: variableMatch[1],
        kind: "variable",
        signature: singleLineSignature(trimmed),
        exported: !variableMatch[1].startsWith("_"),
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: variableMatch[2]
      });
    }
  }

  if (explicitExports.length > 0) {
    const explicitExportSet = new Set(explicitExports);
    for (const symbol of draftSymbols) {
      symbol.exported = explicitExportSet.has(symbol.name);
    }
    exportLabels.push(...explicitExports);
  }

  return finalizeCodeAnalysis(manifest, "python", imports, draftSymbols, exportLabels, diagnostics);
}

function collectBracedBlock(lines: string[], startIndex: number): { text: string; endIndex: number } {
  const parts: string[] = [];
  let depth = 0;
  let started = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    parts.push(line);
    for (const character of line) {
      if (character === "{") {
        depth += 1;
        started = true;
      } else if (character === "}") {
        depth -= 1;
      }
    }
    if (started && depth <= 0) {
      return { text: parts.join("\n"), endIndex: index };
    }
  }

  return {
    text: parts.join("\n"),
    endIndex: started ? lines.length - 1 : startIndex
  };
}

function exportedByCapitalization(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function parseGoImportLine(line: string): CodeImport | undefined {
  const match = line.trim().match(/^(?:([._A-Za-z]\w*)\s+)?"([^"]+)"$/);
  if (!match) {
    return undefined;
  }

  return {
    specifier: match[2],
    importedSymbols: [],
    namespaceImport: match[1] && ![".", "_"].includes(match[1]) ? match[1] : undefined,
    isExternal: !isRelativeSpecifier(match[2]),
    reExport: false
  };
}

function receiverTypeName(receiver: string): string {
  const tokens = receiver
    .replace(/[()*]/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return normalizeSymbolReference(tokens.at(-1) ?? "");
}

function _analyzeGoCode(manifest: SourceManifest, content: string): CodeAnalysis {
  const lines = splitLines(content);
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const diagnostics: CodeDiagnostic[] = [];
  let packageName: string | undefined;

  let inImportBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//")) {
      continue;
    }

    const packageMatch = trimmed.match(/^package\s+([A-Za-z_]\w*)$/);
    if (packageMatch) {
      packageName = packageMatch[1];
      continue;
    }

    if (inImportBlock) {
      if (trimmed === ")") {
        inImportBlock = false;
        continue;
      }
      const parsed = parseGoImportLine(trimmed);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    const importBlockMatch = trimmed.match(/^import\s+\($/);
    if (importBlockMatch) {
      inImportBlock = true;
      continue;
    }

    const singleImportMatch = trimmed.match(/^import\s+(.+)$/);
    if (singleImportMatch) {
      const parsed = parseGoImportLine(singleImportMatch[1]);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    const typeMatch = trimmed.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/);
    if (typeMatch) {
      const exported = exportedByCapitalization(typeMatch[1]);
      draftSymbols.push({
        name: typeMatch[1],
        kind: typeMatch[2] === "interface" ? "interface" : "struct",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: collectBracedBlock(lines, index).text
      });
      if (exported) {
        exportLabels.push(typeMatch[1]);
      }
      continue;
    }

    const aliasTypeMatch = trimmed.match(/^type\s+([A-Za-z_]\w*)\b(?!\s+(?:struct|interface)\b)/);
    if (aliasTypeMatch) {
      const exported = exportedByCapitalization(aliasTypeMatch[1]);
      draftSymbols.push({
        name: aliasTypeMatch[1],
        kind: "type_alias",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: trimmed
      });
      if (exported) {
        exportLabels.push(aliasTypeMatch[1]);
      }
      continue;
    }

    const funcMatch = trimmed.match(/^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)\s*\(/);
    if (funcMatch) {
      const receiverType = funcMatch[1] ? receiverTypeName(funcMatch[1]) : "";
      const symbolName = receiverType ? `${receiverType}.${funcMatch[2]}` : funcMatch[2];
      const exported = exportedByCapitalization(funcMatch[2]);
      const block = collectBracedBlock(lines, index);
      draftSymbols.push({
        name: symbolName,
        kind: "function",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: block.text
      });
      if (exported) {
        exportLabels.push(symbolName);
      }
      index = block.endIndex;
      continue;
    }

    const variableMatch = trimmed.match(/^(?:var|const)\s+([A-Za-z_]\w*)\b/);
    if (variableMatch) {
      const exported = exportedByCapitalization(variableMatch[1]);
      draftSymbols.push({
        name: variableMatch[1],
        kind: "variable",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: trimmed
      });
      if (exported) {
        exportLabels.push(variableMatch[1]);
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "go", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: packageName
  });
}

function analyzeRustUseStatement(statement: string): CodeImport {
  const cleaned = statement
    .replace(/^pub\s+/, "")
    .replace(/^use\s+/, "")
    .replace(/;$/, "")
    .trim();
  const aliasMatch = cleaned.match(/\s+as\s+([A-Za-z_]\w*)$/);
  const withoutAlias = aliasMatch ? cleaned.slice(0, aliasMatch.index).trim() : cleaned;
  const braceMatch = withoutAlias.match(/^(.*)::\{(.+)\}$/);
  const importedSymbols = braceMatch
    ? braceMatch[2]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [aliasMatch ? `${normalizeSymbolReference(withoutAlias)} as ${aliasMatch[1]}` : normalizeSymbolReference(withoutAlias)].filter(
        Boolean
      );
  const specifier = braceMatch ? braceMatch[1].trim() : withoutAlias;
  return {
    specifier,
    importedSymbols,
    isExternal: !/^(crate|self|super)::/.test(specifier),
    reExport: statement.trim().startsWith("pub use ")
  };
}

function rustVisibilityPrefix(trimmed: string): boolean {
  return /^(pub(?:\([^)]*\))?\s+)/.test(trimmed);
}

function _analyzeRustCode(manifest: SourceManifest, content: string): CodeAnalysis {
  const lines = splitLines(content);
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const diagnostics: CodeDiagnostic[] = [];
  const symbolByName = new Map<string, DraftCodeSymbol>();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//")) {
      continue;
    }

    const useMatch = trimmed.match(/^(?:pub\s+)?use\s+.+;$/);
    if (useMatch) {
      imports.push(analyzeRustUseStatement(trimmed));
      continue;
    }

    const functionMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch) {
      const exported = rustVisibilityPrefix(trimmed);
      const block = collectBracedBlock(lines, index);
      const symbol: DraftCodeSymbol = {
        name: functionMatch[1],
        kind: "function",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: block.text
      };
      draftSymbols.push(symbol);
      symbolByName.set(symbol.name, symbol);
      if (exported) {
        exportLabels.push(symbol.name);
      }
      index = block.endIndex;
      continue;
    }

    const structMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)\b/);
    if (structMatch) {
      const exported = rustVisibilityPrefix(trimmed);
      const block = collectBracedBlock(lines, index);
      const symbol: DraftCodeSymbol = {
        name: structMatch[1],
        kind: "struct",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: block.text
      };
      draftSymbols.push(symbol);
      symbolByName.set(symbol.name, symbol);
      if (exported) {
        exportLabels.push(symbol.name);
      }
      index = block.endIndex;
      continue;
    }

    const enumMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)\b/);
    if (enumMatch) {
      const exported = rustVisibilityPrefix(trimmed);
      const block = collectBracedBlock(lines, index);
      const symbol: DraftCodeSymbol = {
        name: enumMatch[1],
        kind: "enum",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: block.text
      };
      draftSymbols.push(symbol);
      symbolByName.set(symbol.name, symbol);
      if (exported) {
        exportLabels.push(symbol.name);
      }
      index = block.endIndex;
      continue;
    }

    const traitMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)\b/);
    if (traitMatch) {
      const exported = rustVisibilityPrefix(trimmed);
      const block = collectBracedBlock(lines, index);
      const symbol: DraftCodeSymbol = {
        name: traitMatch[1],
        kind: "trait",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: block.text
      };
      draftSymbols.push(symbol);
      symbolByName.set(symbol.name, symbol);
      if (exported) {
        exportLabels.push(symbol.name);
      }
      index = block.endIndex;
      continue;
    }

    const aliasMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)\s*=/);
    if (aliasMatch) {
      const exported = rustVisibilityPrefix(trimmed);
      const symbol: DraftCodeSymbol = {
        name: aliasMatch[1],
        kind: "type_alias",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: trimmed
      };
      draftSymbols.push(symbol);
      symbolByName.set(symbol.name, symbol);
      if (exported) {
        exportLabels.push(symbol.name);
      }
      continue;
    }

    const variableMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)\b/);
    if (variableMatch) {
      const exported = rustVisibilityPrefix(trimmed);
      const symbol: DraftCodeSymbol = {
        name: variableMatch[1],
        kind: "variable",
        signature: singleLineSignature(trimmed),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: trimmed
      };
      draftSymbols.push(symbol);
      symbolByName.set(symbol.name, symbol);
      if (exported) {
        exportLabels.push(symbol.name);
      }
      continue;
    }

    const implMatch = trimmed.match(/^impl(?:<[^>]+>)?\s+(.+?)\s+for\s+([A-Za-z_][\w:<>]*)/);
    if (implMatch) {
      const traitName = normalizeSymbolReference(implMatch[1]);
      const typeName = normalizeSymbolReference(implMatch[2]);
      const symbol = symbolByName.get(typeName);
      if (symbol && traitName) {
        symbol.implementsNames.push(traitName);
      }
    }
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const traitMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)\b/);
    if (!traitMatch || symbolByName.has(traitMatch[1])) {
      continue;
    }

    const exported = rustVisibilityPrefix(trimmed);
    const symbol: DraftCodeSymbol = {
      name: traitMatch[1],
      kind: "trait",
      signature: singleLineSignature(trimmed),
      exported,
      callNames: [],
      extendsNames: [],
      implementsNames: [],
      bodyText: trimmed
    };
    draftSymbols.push(symbol);
    symbolByName.set(symbol.name, symbol);
    if (exported) {
      exportLabels.push(symbol.name);
    }
  }

  return finalizeCodeAnalysis(manifest, "rust", imports, draftSymbols, exportLabels, diagnostics);
}

function analyzeJavaImport(statement: string): CodeImport {
  const cleaned = statement
    .replace(/^import\s+/, "")
    .replace(/^static\s+/, "")
    .replace(/;$/, "")
    .trim();
  const symbolName = normalizeSymbolReference(cleaned.replace(/\.\*$/, ""));
  return {
    specifier: cleaned.replace(/\.\*$/, ""),
    importedSymbols: symbolName ? [symbolName] : [],
    isExternal: true,
    reExport: false
  };
}

function parseJavaImplements(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => normalizeSymbolReference(item))
    .filter(Boolean);
}

function _analyzeJavaCode(manifest: SourceManifest, content: string): CodeAnalysis {
  const lines = splitLines(content);
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const diagnostics: CodeDiagnostic[] = [];
  let depth = 0;
  let packageName: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    const lineDepth = depth;

    if (lineDepth === 0) {
      const packageMatch = trimmed.match(/^package\s+([A-Za-z_][\w.]*)\s*;$/);
      if (packageMatch) {
        packageName = packageMatch[1];
        continue;
      }
    }

    if (lineDepth === 0 && trimmed.startsWith("import ")) {
      imports.push(analyzeJavaImport(trimmed));
    }

    if (lineDepth === 0) {
      const classMatch = trimmed.match(
        /^(public\s+)?(?:abstract\s+|final\s+|sealed\s+|non-sealed\s+)*class\s+([A-Za-z_]\w*)\b(?:\s+extends\s+([A-Za-z_][\w.<>]*))?(?:\s+implements\s+([A-Za-z_][\w.,<>\s]*))?/
      );
      if (classMatch) {
        const exported = Boolean(classMatch[1]);
        const block = collectBracedBlock(lines, index);
        draftSymbols.push({
          name: classMatch[2],
          kind: "class",
          signature: singleLineSignature(trimmed),
          exported,
          callNames: [],
          extendsNames: classMatch[3] ? [classMatch[3]] : [],
          implementsNames: parseJavaImplements(classMatch[4]),
          bodyText: block.text
        });
        if (exported) {
          exportLabels.push(classMatch[2]);
        }
        index = block.endIndex;
        depth = 0;
        continue;
      }

      const interfaceMatch = trimmed.match(
        /^(public\s+)?(?:sealed\s+|non-sealed\s+)?interface\s+([A-Za-z_]\w*)\b(?:\s+extends\s+([A-Za-z_][\w.,<>\s]*))?/
      );
      if (interfaceMatch) {
        const exported = Boolean(interfaceMatch[1]);
        const block = collectBracedBlock(lines, index);
        draftSymbols.push({
          name: interfaceMatch[2],
          kind: "interface",
          signature: singleLineSignature(trimmed),
          exported,
          callNames: [],
          extendsNames: parseJavaImplements(interfaceMatch[3]),
          implementsNames: [],
          bodyText: block.text
        });
        if (exported) {
          exportLabels.push(interfaceMatch[2]);
        }
        index = block.endIndex;
        depth = 0;
        continue;
      }

      const enumMatch = trimmed.match(/^(public\s+)?enum\s+([A-Za-z_]\w*)\b(?:\s+implements\s+([A-Za-z_][\w.,<>\s]*))?/);
      if (enumMatch) {
        const exported = Boolean(enumMatch[1]);
        const block = collectBracedBlock(lines, index);
        draftSymbols.push({
          name: enumMatch[2],
          kind: "enum",
          signature: singleLineSignature(trimmed),
          exported,
          callNames: [],
          extendsNames: [],
          implementsNames: parseJavaImplements(enumMatch[3]),
          bodyText: block.text
        });
        if (exported) {
          exportLabels.push(enumMatch[2]);
        }
        index = block.endIndex;
        depth = 0;
        continue;
      }

      const recordMatch = trimmed.match(
        /^(public\s+)?record\s+([A-Za-z_]\w*)\b(?:\s*\([^)]*\))?(?:\s+implements\s+([A-Za-z_][\w.,<>\s]*))?/
      );
      if (recordMatch) {
        const exported = Boolean(recordMatch[1]);
        const block = collectBracedBlock(lines, index);
        draftSymbols.push({
          name: recordMatch[2],
          kind: "class",
          signature: singleLineSignature(trimmed),
          exported,
          callNames: [],
          extendsNames: [],
          implementsNames: parseJavaImplements(recordMatch[3]),
          bodyText: block.text
        });
        if (exported) {
          exportLabels.push(recordMatch[2]);
        }
        index = block.endIndex;
        depth = 0;
        continue;
      }
    }

    for (const character of rawLine) {
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "java", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: packageName
  });
}

function parseCSharpImplements(value?: string): { extendsNames: string[]; implementsNames: string[] } {
  const items = (value ?? "")
    .split(",")
    .map((item) => normalizeSymbolReference(item))
    .filter(Boolean);
  return {
    extendsNames: items.slice(0, 1),
    implementsNames: items.slice(1)
  };
}

function analyzeCSharpUsing(statement: string): CodeImport {
  const cleaned = statement
    .replace(/^global\s+/, "")
    .replace(/^using\s+/, "")
    .replace(/^static\s+/, "")
    .replace(/;$/, "")
    .trim();
  const aliasMatch = cleaned.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
  const specifier = (aliasMatch ? aliasMatch[2] : cleaned).trim();
  return {
    specifier,
    importedSymbols: aliasMatch ? [aliasMatch[1]] : [normalizeSymbolReference(specifier)].filter(Boolean),
    namespaceImport: aliasMatch?.[1],
    isExternal: true,
    reExport: false
  };
}

function _analyzeCSharpCode(manifest: SourceManifest, content: string): CodeAnalysis {
  const lines = splitLines(content);
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const diagnostics: CodeDiagnostic[] = [];
  let depth = 0;
  let namespaceName: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    const lineDepth = depth;
    if (!trimmed || trimmed.startsWith("//")) {
      for (const character of rawLine) {
        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
        }
      }
      continue;
    }

    if (lineDepth === 0) {
      const namespaceMatch = trimmed.match(/^namespace\s+([A-Za-z_][\w.]*)\s*(?:;|\{)?$/);
      if (namespaceMatch) {
        namespaceName = namespaceMatch[1];
      }

      if (/^(?:global\s+)?using\s+/.test(trimmed)) {
        imports.push(analyzeCSharpUsing(trimmed));
      } else {
        const typeMatch = trimmed.match(
          /^(?:\[.+?\]\s*)*(?:(?:public|internal|private|protected|file|abstract|sealed|static|partial|readonly|unsafe|new)\s+)*(class|interface|enum|struct|record)\s+([A-Za-z_]\w*)\b(?:\s*:\s*([^/{]+))?/
        );
        if (typeMatch) {
          const kindMap: Record<string, CodeSymbolKind> = {
            class: "class",
            interface: "interface",
            enum: "enum",
            struct: "struct",
            record: "class"
          };
          const exported = /\bpublic\b/.test(trimmed);
          const inheritance =
            typeMatch[1] === "interface"
              ? {
                  extendsNames: (typeMatch[3] ?? "")
                    .split(",")
                    .map((item) => normalizeSymbolReference(item))
                    .filter(Boolean),
                  implementsNames: []
                }
              : parseCSharpImplements(typeMatch[3]);
          const block = collectBracedBlock(lines, index);
          draftSymbols.push({
            name: typeMatch[2],
            kind: kindMap[typeMatch[1]],
            signature: singleLineSignature(trimmed),
            exported,
            callNames: [],
            extendsNames: inheritance.extendsNames,
            implementsNames: inheritance.implementsNames,
            bodyText: block.text
          });
          if (exported) {
            exportLabels.push(typeMatch[2]);
          }
          index = block.endIndex;
          depth = 0;
          continue;
        }

        const functionMatch = trimmed.match(
          /^(?:(?:public|internal|private|protected|static|async|virtual|override|sealed|partial|unsafe|extern)\s+)+[A-Za-z_][\w<>,?.[\]\s]*\s+([A-Za-z_]\w*)\s*\([^;{)]*\)\s*(?:\{|=>)/
        );
        if (functionMatch) {
          const exported = /\bpublic\b/.test(trimmed);
          const block = trimmed.includes("{") ? collectBracedBlock(lines, index) : { text: trimmed, endIndex: index };
          draftSymbols.push({
            name: functionMatch[1],
            kind: "function",
            signature: singleLineSignature(trimmed),
            exported,
            callNames: [],
            extendsNames: [],
            implementsNames: [],
            bodyText: block.text
          });
          if (exported) {
            exportLabels.push(functionMatch[1]);
          }
          index = block.endIndex;
          depth = 0;
          continue;
        }
      }
    }

    for (const character of rawLine) {
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "csharp", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: namespaceName
  });
}

function analyzePhpUse(statement: string): CodeImport {
  const cleaned = statement
    .replace(/^use\s+/, "")
    .replace(/;$/, "")
    .trim();
  const aliasMatch = cleaned.match(/^(.+?)\s+as\s+([A-Za-z_]\w*)$/i);
  const specifier = (aliasMatch ? aliasMatch[1] : cleaned).trim();
  return {
    specifier,
    importedSymbols: [normalizeSymbolReference(specifier)].filter(Boolean),
    namespaceImport: aliasMatch?.[2],
    isExternal: true,
    reExport: false
  };
}

function _analyzePhpCode(manifest: SourceManifest, content: string): CodeAnalysis {
  const lines = splitLines(content);
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const diagnostics: CodeDiagnostic[] = [];
  let depth = 0;
  let namespaceName: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    const lineDepth = depth;
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      for (const character of rawLine) {
        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
        }
      }
      continue;
    }

    if (lineDepth === 0) {
      const namespaceMatch = trimmed.match(/^namespace\s+([^;]+);$/);
      if (namespaceMatch) {
        namespaceName = namespaceMatch[1].trim();
        continue;
      }
      if (trimmed.startsWith("use ")) {
        imports.push(analyzePhpUse(trimmed));
        continue;
      }

      const includeMatch = trimmed.match(/^(?:require|require_once|include|include_once)\s*(?:\(|)\s*['"]([^'"]+)['"]/);
      if (includeMatch) {
        imports.push({
          specifier: includeMatch[1],
          importedSymbols: [],
          isExternal: !isLocalIncludeSpecifier(includeMatch[1]),
          reExport: false
        });
        continue;
      }

      const classMatch = trimmed.match(
        /^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)\b(?:\s+extends\s+([A-Za-z_\\][\w\\]*))?(?:\s+implements\s+([A-Za-z_\\][\w\\,\s]*))?/
      );
      if (classMatch) {
        const block = collectBracedBlock(lines, index);
        draftSymbols.push({
          name: classMatch[2],
          kind:
            classMatch[1] === "interface" ? "interface" : classMatch[1] === "trait" ? "trait" : classMatch[1] === "enum" ? "enum" : "class",
          signature: singleLineSignature(trimmed),
          exported: true,
          callNames: [],
          extendsNames: classMatch[3] ? [classMatch[3]] : [],
          implementsNames: classMatch[4]
            ? classMatch[4]
                .split(",")
                .map((item) => normalizeSymbolReference(item))
                .filter(Boolean)
            : [],
          bodyText: block.text
        });
        exportLabels.push(classMatch[2]);
        index = block.endIndex;
        depth = 0;
        continue;
      }

      const functionMatch = trimmed.match(/^function\s+([A-Za-z_]\w*)\s*\(/);
      if (functionMatch) {
        const block = collectBracedBlock(lines, index);
        draftSymbols.push({
          name: functionMatch[1],
          kind: "function",
          signature: singleLineSignature(trimmed),
          exported: true,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: block.text
        });
        exportLabels.push(functionMatch[1]);
        index = block.endIndex;
        depth = 0;
        continue;
      }

      const constMatch = trimmed.match(/^const\s+([A-Za-z_]\w*)\b/);
      if (constMatch) {
        draftSymbols.push({
          name: constMatch[1],
          kind: "variable",
          signature: singleLineSignature(trimmed),
          exported: true,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: trimmed
        });
        exportLabels.push(constMatch[1]);
      }
    }

    for (const character of rawLine) {
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "php", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: namespaceName
  });
}

function analyzeCFamilyInclude(statement: string): CodeImport | undefined {
  const match = statement.match(/^#include\s*([<"])([^>"]+)[>"]$/);
  if (!match) {
    return undefined;
  }
  return {
    specifier: match[2].trim(),
    importedSymbols: [],
    isExternal: match[1] === "<",
    reExport: false
  };
}

function _analyzeCFamilyCode(manifest: SourceManifest, content: string): CodeAnalysis {
  const language = manifest.language === "c" ? "c" : "cpp";
  const lines = splitLines(content);
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const diagnostics: CodeDiagnostic[] = [];
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    const lineDepth = depth;
    if (!trimmed || trimmed.startsWith("//")) {
      for (const character of rawLine) {
        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
        }
      }
      continue;
    }

    if (lineDepth === 0) {
      const parsedInclude = analyzeCFamilyInclude(trimmed);
      if (parsedInclude) {
        imports.push(parsedInclude);
        continue;
      }

      const typeMatch = trimmed.match(/^(struct|class|enum)\s+([A-Za-z_]\w*)\b(?:\s*:\s*([^/{]+))?/);
      if (typeMatch) {
        const block = collectBracedBlock(lines, index);
        draftSymbols.push({
          name: typeMatch[2],
          kind: typeMatch[1] === "enum" ? "enum" : typeMatch[1] === "struct" ? "struct" : "class",
          signature: singleLineSignature(trimmed),
          exported: true,
          callNames: [],
          extendsNames: typeMatch[3]
            ? typeMatch[3]
                .split(",")
                .map((item) => normalizeSymbolReference(item))
                .filter(Boolean)
            : [],
          implementsNames: [],
          bodyText: block.text
        });
        exportLabels.push(typeMatch[2]);
        index = block.endIndex;
        depth = 0;
        continue;
      }

      const functionMatch = trimmed.match(
        /^(?!if\b|for\b|while\b|switch\b|return\b)(?:[A-Za-z_~][\w:<>,*&\s]*\s+)+([A-Za-z_~]\w*)\s*\([^;{)]*\)\s*(?:\{|;)$/
      );
      if (functionMatch) {
        const block = trimmed.endsWith("{") ? collectBracedBlock(lines, index) : { text: trimmed, endIndex: index };
        draftSymbols.push({
          name: functionMatch[1],
          kind: "function",
          signature: singleLineSignature(trimmed),
          exported: true,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: block.text
        });
        exportLabels.push(functionMatch[1]);
        index = block.endIndex;
        depth = 0;
        continue;
      }
    }

    for (const character of rawLine) {
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      }
    }
  }

  return finalizeCodeAnalysis(manifest, language, imports, draftSymbols, exportLabels, diagnostics);
}

function statementRationaleSymbolName(statement: ts.Statement): string | undefined {
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return statement.name.text;
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return statement.name.text;
  }
  if (ts.isVariableStatement(statement)) {
    const first = statement.declarationList.declarations[0];
    return first && ts.isIdentifier(first.name) ? first.name.text : undefined;
  }
  return undefined;
}

function extractTypeScriptRationales(manifest: SourceManifest, content: string, sourceFile: ts.SourceFile): SourceRationale[] {
  const rationales: SourceRationale[] = [];
  let index = 0;

  const pushRationale = (rawText: string, symbolName?: string, kind?: SourceRationale["kind"]) => {
    const rationale = makeRationale(manifest, index + 1, rawText, kind ?? rationaleKindFromText(rawText), symbolName);
    if (rationale) {
      rationales.push(rationale);
      index += 1;
    }
  };

  const firstStatement = sourceFile.statements[0];
  if (firstStatement) {
    for (const range of ts.getLeadingCommentRanges(content, firstStatement.getFullStart()) ?? []) {
      pushRationale(content.slice(range.pos, range.end));
    }
  }

  for (const statement of sourceFile.statements) {
    const symbolName = statementRationaleSymbolName(statement);
    for (const jsDoc of (statement as ts.Node & { jsDoc?: ts.JSDoc[] }).jsDoc ?? []) {
      pushRationale(jsDoc.getText(sourceFile), symbolName, "docstring");
    }
    for (const range of ts.getLeadingCommentRanges(content, statement.getFullStart()) ?? []) {
      pushRationale(content.slice(range.pos, range.end), symbolName);
    }
  }

  return uniqueBy(rationales, (item) => `${item.symbolName ?? ""}:${item.text.toLowerCase()}`);
}

function analyzeTypeScriptLikeCode(
  manifest: SourceManifest,
  content: string
): {
  code: CodeAnalysis;
  rationales: SourceRationale[];
} {
  const language = manifest.language ?? inferCodeLanguage(manifest.originalPath ?? manifest.storedPath, manifest.mimeType) ?? "typescript";
  const sourceFile = ts.createSourceFile(
    manifest.originalPath ?? manifest.storedPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(language)
  );

  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const localExportNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
      if (specifier) {
        let defaultImport: string | undefined;
        let namespaceImport: string | undefined;
        let importedSymbols: string[] = [];
        if (statement.importClause?.name) {
          defaultImport = statement.importClause.name.text;
        }
        const namedBindings = statement.importClause?.namedBindings;
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
          namespaceImport = namedBindings.name.text;
        } else if (namedBindings && ts.isNamedImports(namedBindings)) {
          importedSymbols = namedBindings.elements.map(importSpecifierText);
        }

        imports.push({
          specifier,
          importedSymbols,
          defaultImport,
          namespaceImport,
          isTypeOnly: statement.importClause?.isTypeOnly ?? false,
          isExternal: !isRelativeSpecifier(specifier),
          reExport: false
        });
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      const exportedSymbols =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements.map(exportSpecifierText)
          : statement.exportClause
            ? [statement.exportClause.getText(sourceFile)]
            : ["*"];

      if (specifier) {
        imports.push({
          specifier,
          importedSymbols: exportedSymbols,
          isTypeOnly: statement.isTypeOnly,
          isExternal: !isRelativeSpecifier(specifier),
          reExport: true
        });
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          localExportNames.add(element.propertyName?.text ?? element.name.text);
          exportLabels.push(exportSpecifierText(element));
        }
      }

      exportLabels.push(...exportedSymbols);
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        localExportNames.add(statement.expression.text);
        exportLabels.push(`default (${statement.expression.text})`);
      } else {
        exportLabels.push("default");
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      draftSymbols.push({
        name: statement.name.text,
        kind: "function",
        signature: declarationSignature(statement, sourceFile),
        exported: isNodeExported(statement),
        callNames: [],
        extendsNames: [],
        implementsNames: []
      });
      if (isNodeExported(statement)) {
        localExportNames.add(statement.name.text);
        exportLabels.push(statement.name.text);
      }
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      draftSymbols.push({
        name: statement.name.text,
        kind: "class",
        signature: declarationSignature(statement, sourceFile),
        exported: isNodeExported(statement),
        callNames: [],
        extendsNames: heritageNames(statement.heritageClauses, ts.SyntaxKind.ExtendsKeyword),
        implementsNames: heritageNames(statement.heritageClauses, ts.SyntaxKind.ImplementsKeyword)
      });
      if (isNodeExported(statement)) {
        localExportNames.add(statement.name.text);
        exportLabels.push(statement.name.text);
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      draftSymbols.push({
        name: statement.name.text,
        kind: "interface",
        signature: declarationSignature(statement, sourceFile),
        exported: isNodeExported(statement),
        callNames: [],
        extendsNames: heritageNames(statement.heritageClauses, ts.SyntaxKind.ExtendsKeyword),
        implementsNames: []
      });
      if (isNodeExported(statement)) {
        localExportNames.add(statement.name.text);
        exportLabels.push(statement.name.text);
      }
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      draftSymbols.push({
        name: statement.name.text,
        kind: "type_alias",
        signature: declarationSignature(statement, sourceFile),
        exported: isNodeExported(statement),
        callNames: [],
        extendsNames: [],
        implementsNames: []
      });
      if (isNodeExported(statement)) {
        localExportNames.add(statement.name.text);
        exportLabels.push(statement.name.text);
      }
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      draftSymbols.push({
        name: statement.name.text,
        kind: "enum",
        signature: declarationSignature(statement, sourceFile),
        exported: isNodeExported(statement),
        callNames: [],
        extendsNames: [],
        implementsNames: []
      });
      if (isNodeExported(statement)) {
        localExportNames.add(statement.name.text);
        exportLabels.push(statement.name.text);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = isNodeExported(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue;
        }
        draftSymbols.push({
          name: declaration.name.text,
          kind: resolveVariableKind(statement),
          signature: declarationSignature(statement, sourceFile),
          exported,
          callNames: [],
          extendsNames: [],
          implementsNames: []
        });
        if (exported) {
          localExportNames.add(declaration.name.text);
          exportLabels.push(declaration.name.text);
        }
      }
    }
  }

  const topLevelNames = new Set(draftSymbols.map((symbol) => symbol.name));

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const symbol = draftSymbols.find((item) => item.name === statement.name?.text && item.kind === "function");
      if (symbol) {
        symbol.callNames = collectCallNames(statement.body, topLevelNames, symbol.name);
      }
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      const symbol = draftSymbols.find((item) => item.name === statement.name?.text && item.kind === "class");
      if (symbol) {
        symbol.callNames = collectCallNames(statement, topLevelNames, symbol.name);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue;
        }
        const declarationName = declaration.name.text;
        const symbol = draftSymbols.find((item) => item.name === declarationName && item.kind === "variable");
        if (symbol) {
          symbol.callNames = collectCallNames(declaration.initializer, topLevelNames, symbol.name);
        }
      }
    }
  }

  const parseDiagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const diagnostics: CodeDiagnostic[] = parseDiagnostics.map((diagnostic: ts.DiagnosticWithLocation) => {
    const position = diagnostic.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
    return {
      code: diagnostic.code,
      category: formatDiagnosticCategory(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      line: (position?.line ?? 0) + 1,
      column: (position?.character ?? 0) + 1
    };
  });

  return {
    code: finalizeCodeAnalysis(manifest, language, imports, draftSymbols, exportLabels, diagnostics),
    rationales: extractTypeScriptRationales(manifest, content, sourceFile)
  };
}

export function inferCodeLanguage(filePath: string, mimeType = "", options: CodeLanguageDetectionOptions = {}): CodeLanguage | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return "typescript";
  }
  if (extension === ".tsx") {
    return "tsx";
  }
  if (extension === ".jsx") {
    return "jsx";
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs" || mimeType.includes("javascript")) {
    return "javascript";
  }
  if (extension === ".sh" || extension === ".bash" || extension === ".zsh" || mimeType === "application/x-sh") {
    return "bash";
  }
  if (extension === ".py") {
    return "python";
  }
  if (extension === ".go") {
    return "go";
  }
  if (extension === ".rs") {
    return "rust";
  }
  if (extension === ".java") {
    return "java";
  }
  if (extension === ".kt" || extension === ".kts") {
    return "kotlin";
  }
  if (extension === ".scala" || extension === ".sc") {
    return "scala";
  }
  if (extension === ".dart") {
    return "dart";
  }
  if (extension === ".lua") {
    return "lua";
  }
  if (extension === ".zig") {
    return "zig";
  }
  if (extension === ".cs") {
    return "csharp";
  }
  if (extension === ".php") {
    return "php";
  }
  if (extension === ".rb") {
    return "ruby";
  }
  if (extension === ".ps1" || extension === ".psm1" || extension === ".psd1") {
    return "powershell";
  }
  if (extension === ".swift") {
    return "swift";
  }
  if (extension === ".ex" || extension === ".exs") {
    return "elixir";
  }
  if (extension === ".ml" || extension === ".mli") {
    return "ocaml";
  }
  // Objective-C: only claim .m and .mm. Leave .h resolving to cpp (existing
  // behavior) because ObjC and C++ headers are textually indistinguishable
  // without content sniffing, and treating .h as cpp is a safe default for
  // mixed ObjC/C++ codebases.
  if (extension === ".m" || extension === ".mm") {
    return "objc";
  }
  if (extension === ".res" || extension === ".resi") {
    return "rescript";
  }
  if (extension === ".sol") {
    return "solidity";
  }
  if (extension === ".html" || extension === ".htm") {
    return "html";
  }
  if (extension === ".css") {
    return "css";
  }
  if (extension === ".vue") {
    return "vue";
  }
  if (extension === ".c") {
    return "c";
  }
  if ([".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"].includes(extension)) {
    return "cpp";
  }
  if (!extension && options.executable) {
    const fromShebang = languageFromInterpreter(interpreterFromShebang(options.content));
    if (fromShebang) {
      return fromShebang;
    }
  }
  return undefined;
}

export function modulePageTitle(manifest: SourceManifest): string {
  return `${manifest.title} module`;
}

function importResolutionCandidates(basePath: string, specifier: string, extensions: string[]): string[] {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(basePath), specifier));
  const resolvedExt = path.posix.extname(resolved);
  if (resolvedExt) {
    // Modern TypeScript code (`"type": "module"` or the NodeNext module resolution mode)
    // imports sibling files using runtime extensions like `.js` / `.mjs` / `.cjs` even
    // when the source on disk is `.ts` / `.mts` / `.cts`. Likewise `.jsx` may point at
    // `.tsx`. Retry the candidate list with sibling extensions substituted so those
    // rewritten specifiers still match the real source file.
    if (extensions.includes(resolvedExt)) {
      const resolvedBase = resolved.slice(0, -resolvedExt.length);
      const candidates = [resolved, ...extensions.map((extension) => `${resolvedBase}${extension}`)];
      return uniqueBy(candidates, (candidate) => candidate);
    }
    return [resolved];
  }

  const direct = extensions.map((extension) => path.posix.normalize(`${resolved}${extension}`));
  const indexFiles = extensions.map((extension) => path.posix.normalize(path.posix.join(resolved, `index${extension}`)));
  return uniqueBy([resolved, ...direct, ...indexFiles], (candidate) => candidate);
}

function normalizeAlias(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
}

function recordAlias(target: Set<string>, value?: string): void {
  const normalized = normalizeAlias(value ?? "");
  if (!normalized) {
    return;
  }
  target.add(normalized);
  const lowered = normalized.toLowerCase();
  if (lowered !== normalized) {
    target.add(lowered);
  }
}

function manifestBasenameWithoutExtension(manifest: SourceManifest): string {
  const target = manifest.repoRelativePath ?? manifest.originalPath ?? manifest.storedPath;
  return path.posix.basename(stripCodeExtension(normalizeAlias(target)));
}

type DartPackageInfo = {
  rootDir: string;
  name: string;
};

async function readNearestDartPackageInfo(
  startPath: string,
  cache: Map<string, DartPackageInfo | null>
): Promise<DartPackageInfo | undefined> {
  let current = path.resolve(startPath);
  try {
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (cache.has(current)) {
      const cached = cache.get(current);
      return cached === null ? undefined : cached;
    }
    const pubspecPath = path.join(current, "pubspec.yaml");
    if (
      await fs
        .access(pubspecPath)
        .then(() => true)
        .catch(() => false)
    ) {
      try {
        const content = await fs.readFile(pubspecPath, "utf8");
        const parsed = YAML.parse(content);
        const packageName = typeof parsed?.name === "string" ? parsed.name.trim() : "";
        const info = packageName ? { rootDir: current, name: packageName } : null;
        cache.set(current, info);
        return info ?? undefined;
      } catch {
        cache.set(current, null);
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      cache.set(current, null);
      return undefined;
    }
    current = parent;
  }
}

async function readNearestGoModulePath(startPath: string, cache: Map<string, string | null>): Promise<string | undefined> {
  let current = path.resolve(startPath);
  try {
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (cache.has(current)) {
      const cached = cache.get(current);
      return cached === null ? undefined : cached;
    }
    const goModPath = path.join(current, "go.mod");
    if (
      await fs
        .access(goModPath)
        .then(() => true)
        .catch(() => false)
    ) {
      const content = await fs.readFile(goModPath, "utf8");
      const match = content.match(/^\s*module\s+(\S+)/m);
      const modulePath = match?.[1]?.trim() ?? null;
      cache.set(current, modulePath);
      return modulePath ?? undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      cache.set(current, null);
      return undefined;
    }
    current = parent;
  }
}

// Return every plausible `crate::X::Y` alias for a Rust file path. Rust projects live
// in three common layouts and we cannot tell from the path alone which one applies
// without reading Cargo.toml:
//
//   1. Standard crate:   src/lib.rs → alias `crate::...`
//   2. Nested crate:     some/where/src/lib.rs → alias starts at the rightmost /src/
//   3. Non-src crate:    ripgrep's `crates/core/flags/*` where Cargo.toml at the
//                        workspace root points `[[bin]]` at `crates/core/main.rs`
//
// Rather than parse Cargo.toml, record every progressively-stripped ancestor variant.
// A `filterRustCandidatesToSameCrate` pass at resolution time keeps the matches that
// share the consumer file's crate root, which prevents the broader alias set from
// causing cross-crate collisions.
function rustModuleAliases(repoRelativePath: string): string[] {
  const withoutExt = stripCodeExtension(normalizeAlias(repoRelativePath)).replace(/\/mod$/i, "");
  if (!withoutExt) {
    return [];
  }

  const result: string[] = [];
  const push = (moduleTail: string) => {
    const trimmed = moduleTail.replace(/^\/+|\/+$/g, "");
    if (!trimmed || trimmed === "lib" || trimmed === "main") {
      result.push("crate");
      return;
    }
    // Drop a trailing `/lib` or `/main` so `foo/bar/lib` becomes `crate::foo::bar`.
    const rootStripped = trimmed.replace(/\/(?:lib|main)$/i, "");
    if (rootStripped !== trimmed && rootStripped) {
      result.push(`crate::${rootStripped.replace(/\//g, "::")}`);
    }
    result.push(`crate::${trimmed.replace(/\//g, "::")}`);
  };

  // 1. If the path contains `/src/`, the segment after the right-most `/src/` is the
  //    canonical crate-relative module path. This is the common case.
  const srcIdx = withoutExt.lastIndexOf("/src/");
  if (srcIdx >= 0) {
    push(withoutExt.slice(srcIdx + "/src/".length));
  }

  // 2. Strip the `src/` prefix if the path starts with it (top-level crate).
  if (withoutExt.startsWith("src/")) {
    push(withoutExt.slice("src/".length));
  }

  // 3. Record progressively-stripped ancestor variants so non-standard layouts match.
  //    This is what catches ripgrep-style repos where Cargo.toml's `[[bin]]` points at
  //    a non-src path like `crates/core/main.rs`.
  const segments = withoutExt.split("/").filter(Boolean);
  for (let start = 0; start < segments.length; start += 1) {
    push(segments.slice(start).join("/"));
  }

  return uniqueBy(result.filter(Boolean), (item) => item);
}

function candidateExtensionsFor(language: CodeLanguage): string[] {
  switch (language) {
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx":
      return [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
    case "bash":
      return [".sh", ".bash", ".zsh"];
    case "python":
      return [".py"];
    case "go":
      return [".go"];
    case "rust":
      return [".rs"];
    case "java":
      return [".java"];
    case "kotlin":
      return [".kt", ".kts"];
    case "scala":
      return [".scala", ".sc"];
    case "dart":
      return [".dart"];
    case "lua":
      return [".lua"];
    case "zig":
      return [".zig"];
    case "csharp":
      return [".cs"];
    case "php":
      return [".php"];
    case "ruby":
      return [".rb"];
    case "powershell":
      return [".ps1", ".psm1", ".psd1"];
    case "c":
      return [".c", ".h"];
    case "cpp":
      return [".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"];
    case "swift":
      return [".swift"];
    case "elixir":
      return [".ex", ".exs"];
    case "ocaml":
      return [".ml", ".mli"];
    case "objc":
      // Objective-C source files share `.h` headers with C/C++; a `#import` in
      // a `.m` file may target either an ObjC-specific header or a plain C
      // header in the same repo, so enumerate the common header extensions too.
      return [".m", ".mm", ".h"];
    case "rescript":
      return [".res", ".resi"];
    case "solidity":
      return [".sol"];
    case "html":
      // HTML link/script imports can point at any sibling asset. The primary
      // targets are .css (from <link rel="stylesheet">) and .js/.mjs (from
      // <script src>), so enumerate those along with nested HTML fragments.
      return [".css", ".js", ".mjs", ".cjs", ".html", ".htm"];
    case "css":
      return [".css"];
    default:
      return [];
  }
}

export async function buildCodeIndex(rootDir: string, manifests: SourceManifest[], analyses: SourceAnalysis[]): Promise<CodeIndexArtifact> {
  const analysesBySourceId = new Map(analyses.map((analysis) => [analysis.sourceId, analysis]));
  const goModuleCache = new Map<string, string | null>();
  const dartPackageCache = new Map<string, DartPackageInfo | null>();
  const entries: CodeIndexEntry[] = [];

  for (const manifest of manifests) {
    const analysis = analysesBySourceId.get(manifest.sourceId);
    if (!analysis?.code) {
      continue;
    }

    const aliases = new Set<string>();
    const repoRelativePath = manifest.repoRelativePath ? normalizeAlias(manifest.repoRelativePath) : undefined;
    const normalizedModuleName = analysis.code.moduleName ? normalizeAlias(analysis.code.moduleName) : undefined;
    const normalizedNamespace = analysis.code.namespace ? normalizeAlias(analysis.code.namespace) : undefined;
    const basename = manifestBasenameWithoutExtension(manifest);

    if (repoRelativePath) {
      recordAlias(aliases, repoRelativePath);
      recordAlias(aliases, stripCodeExtension(repoRelativePath));
      if (stripCodeExtension(repoRelativePath).endsWith("/index")) {
        recordAlias(aliases, stripCodeExtension(repoRelativePath).slice(0, -"/index".length));
      }
    }
    recordAlias(aliases, normalizedModuleName);
    recordAlias(aliases, normalizedNamespace);

    switch (analysis.code.language) {
      case "python":
        recordAlias(aliases, normalizedModuleName?.replace(/\//g, "."));
        break;
      case "bash":
        recordAlias(aliases, basename);
        break;
      case "rust":
        if (repoRelativePath) {
          for (const alias of rustModuleAliases(repoRelativePath)) {
            recordAlias(aliases, alias);
          }
        }
        break;
      case "go": {
        if (normalizedNamespace) {
          recordAlias(aliases, normalizedNamespace);
        }
        const originalPath = manifest.originalPath ? path.resolve(manifest.originalPath) : path.resolve(rootDir, manifest.storedPath);
        const goModulePath = await readNearestGoModulePath(originalPath, goModuleCache);
        if (goModulePath && repoRelativePath) {
          const dir = path.posix.dirname(repoRelativePath);
          const packageAlias = dir === "." ? goModulePath : `${goModulePath}/${dir}`;
          recordAlias(aliases, packageAlias);
        }
        break;
      }
      case "java":
      case "kotlin":
      case "scala":
      case "dart":
      case "csharp":
        if (normalizedNamespace) {
          recordAlias(aliases, `${normalizedNamespace}.${basename}`);
        }
        if (normalizedNamespace) {
          for (const symbol of analysis.code.symbols) {
            recordAlias(aliases, `${normalizedNamespace}.${symbol.name}`);
          }
        }
        if (analysis.code.language === "dart" && repoRelativePath) {
          recordAlias(aliases, basename);
          const originalPath = manifest.originalPath ? path.resolve(manifest.originalPath) : path.resolve(rootDir, manifest.storedPath);
          const packageInfo = await readNearestDartPackageInfo(originalPath, dartPackageCache);
          if (packageInfo) {
            const packageRelativePath = toPosix(path.relative(packageInfo.rootDir, originalPath));
            if (packageRelativePath.startsWith("lib/")) {
              const packagePath = packageRelativePath.slice("lib/".length);
              recordAlias(aliases, `package:${packageInfo.name}/${packagePath}`);
              recordAlias(aliases, `package:${packageInfo.name}/${stripCodeExtension(packagePath)}`);
            }
          }
        }
        break;
      case "lua":
        recordAlias(aliases, basename);
        if (repoRelativePath) {
          const repoWithoutExt = stripCodeExtension(repoRelativePath);
          recordAlias(aliases, repoWithoutExt.replace(/\//g, "."));
          if (repoWithoutExt.endsWith("/init")) {
            recordAlias(aliases, repoWithoutExt.slice(0, -"/init".length));
            recordAlias(aliases, repoWithoutExt.slice(0, -"/init".length).replace(/\//g, "."));
          }
        }
        break;
      case "zig":
        recordAlias(aliases, basename);
        break;
      case "php":
        if (normalizedNamespace) {
          recordAlias(aliases, `${normalizedNamespace}\\${basename}`);
        }
        break;
      case "ruby":
      case "powershell":
        recordAlias(aliases, basename);
        break;
      case "elixir":
        // A single Elixir file can hold several `defmodule`/`defprotocol`
        // declarations. finalizeCodeAnalysis only plumbs the first one through
        // `moduleName`, so walk the class/interface symbols that the analyzer
        // emitted and register each of their fully-qualified names as an alias
        // too. Import resolution (`alias Foo.Bar`) can then target any module
        // defined in the file, not just the first.
        for (const symbol of analysis.code.symbols) {
          if (symbol.kind === "class" || symbol.kind === "interface") {
            recordAlias(aliases, symbol.name);
          }
        }
        break;
      case "ocaml": {
        // OCaml's file-derived module name is the basename with its first letter
        // uppercased: `printf.ml` implicitly defines a module named `Printf`.
        // `open Printf` in another file should resolve to this module, so record
        // the capitalized basename as an alias. Also register any nested
        // `module Foo = struct ... end` declarations that the analyzer surfaced
        // as class symbols, so their names become resolvable too.
        if (basename) {
          const capitalized = basename.charAt(0).toUpperCase() + basename.slice(1);
          recordAlias(aliases, capitalized);
          recordAlias(aliases, basename);
        }
        for (const symbol of analysis.code.symbols) {
          if (symbol.kind === "class" || symbol.kind === "interface") {
            recordAlias(aliases, symbol.name);
          }
        }
        break;
      }
      case "rescript": {
        // ReScript follows OCaml's convention: `widget.res` implicitly defines a
        // module `Widget`. Register the capitalized basename plus any nested
        // `module Foo = { ... }` symbols the analyzer emitted as aliases so
        // `open Widget` resolves across files.
        if (basename) {
          const capitalized = basename.charAt(0).toUpperCase() + basename.slice(1);
          recordAlias(aliases, capitalized);
          recordAlias(aliases, basename);
        }
        for (const symbol of analysis.code.symbols) {
          if (symbol.kind === "class") {
            recordAlias(aliases, symbol.name);
          }
        }
        break;
      }
      default:
        break;
    }

    entries.push({
      sourceId: manifest.sourceId,
      moduleId: analysis.code.moduleId,
      language: analysis.code.language,
      repoRelativePath,
      originalPath: manifest.originalPath,
      moduleName: analysis.code.moduleName,
      namespace: analysis.code.namespace,
      aliases: [...aliases].sort((left, right) => left.localeCompare(right))
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    entries
  };
}

type CodeIndexLookup = {
  artifact: CodeIndexArtifact;
  bySourceId: Map<string, CodeIndexEntry>;
  byRepoPath: Map<string, CodeIndexEntry>;
  byAlias: Map<string, CodeIndexEntry[]>;
};

function createCodeIndexLookup(artifact: CodeIndexArtifact): CodeIndexLookup {
  const bySourceId = new Map<string, CodeIndexEntry>();
  const byRepoPath = new Map<string, CodeIndexEntry>();
  const byAlias = new Map<string, CodeIndexEntry[]>();

  for (const entry of artifact.entries) {
    bySourceId.set(entry.sourceId, entry);
    if (entry.repoRelativePath) {
      byRepoPath.set(normalizeAlias(entry.repoRelativePath), entry);
    }
    for (const alias of entry.aliases) {
      const key = normalizeAlias(alias);
      const bucket = byAlias.get(key) ?? [];
      bucket.push(entry);
      byAlias.set(key, bucket);
    }
  }

  return { artifact, bySourceId, byRepoPath, byAlias };
}

function aliasMatches(lookup: CodeIndexLookup, ...aliases: Array<string | undefined>): CodeIndexEntry[] {
  return uniqueBy(
    aliases.flatMap((alias) =>
      alias ? (lookup.byAlias.get(normalizeAlias(alias)) ?? lookup.byAlias.get(normalizeAlias(alias).toLowerCase()) ?? []) : []
    ),
    (entry) => entry.sourceId
  );
}

// Case-exact variant used for Rust, which is case-sensitive — `Error` is a type and
// `error` is a module, so the lowercase fallback in `aliasMatches` would incorrectly
// match `crate::Error` to a sibling `error.rs` in an unrelated crate.
function aliasMatchesExact(lookup: CodeIndexLookup, alias: string): CodeIndexEntry[] {
  return lookup.byAlias.get(normalizeAlias(alias)) ?? [];
}

function repoPathMatches(lookup: CodeIndexLookup, ...repoPaths: string[]): CodeIndexEntry[] {
  return uniqueBy(
    repoPaths.map((repoPath) => lookup.byRepoPath.get(normalizeAlias(repoPath))).filter((entry): entry is CodeIndexEntry => Boolean(entry)),
    (entry) => entry.sourceId
  );
}

function resolvePythonRelativeAliases(repoRelativePath: string, specifier: string): string[] {
  const dotMatch = specifier.match(/^\.+/);
  const depth = dotMatch ? dotMatch[0].length : 0;
  const relativeModule = specifier.slice(depth).replace(/\./g, "/");
  const baseDir = path.posix.dirname(repoRelativePath);
  const parentDir = path.posix.normalize(path.posix.join(baseDir, ...Array(Math.max(depth - 1, 0)).fill("..")));
  const moduleBase = relativeModule ? path.posix.join(parentDir, relativeModule) : parentDir;
  return uniqueBy([`${moduleBase}.py`, path.posix.join(moduleBase, "__init__.py")], (item) => item);
}

function resolveRustAliases(manifest: SourceManifest, specifier: string): string[] {
  const repoRelativePath = manifest.repoRelativePath ? normalizeAlias(manifest.repoRelativePath) : "";
  if (!specifier.startsWith("self::") && !specifier.startsWith("super::") && specifier !== "self" && specifier !== "super") {
    return [specifier];
  }
  const candidateAliases = repoRelativePath ? rustModuleAliases(repoRelativePath) : [];
  if (candidateAliases.length === 0) {
    return [];
  }
  const tailAfter = specifier.startsWith("self::")
    ? specifier.slice("self::".length)
    : specifier.startsWith("super::")
      ? specifier.slice("super::".length)
      : "";
  const superRelative = specifier.startsWith("super");
  const expansions: string[] = [];
  for (const currentAlias of candidateAliases) {
    const currentParts = currentAlias
      .replace(/^crate(?:::)?/, "")
      .split("::")
      .filter(Boolean);
    if (superRelative) {
      if (currentParts.length > 0) {
        const parentParts = currentParts.slice(0, -1);
        const expanded = `crate${parentParts.length ? `::${parentParts.join("::")}` : ""}${tailAfter ? `::${tailAfter}` : ""}`
          .replace(/::+/g, "::")
          .replace(/::$/, "");
        expansions.push(expanded);
      }
      continue;
    }
    const expanded = `crate${currentParts.length ? `::${currentParts.join("::")}` : ""}${tailAfter ? `::${tailAfter}` : ""}`
      .replace(/::+/g, "::")
      .replace(/::$/, "");
    expansions.push(expanded);
  }
  return uniqueBy(expansions, (item) => item);
}

// Longest prefix of a repo-relative path ending at the right-most `/src/`. Used to
// scope Rust crate-rooted imports (`crate::`/`self::`/`super::`) to candidates that
// live in the same Cargo crate, which matters in multi-crate workspaces where every
// lib.rs aliases as `crate` and would otherwise all match at once.
function rustCrateRootPrefix(repoRelativePath: string | undefined): string | undefined {
  if (!repoRelativePath) {
    return undefined;
  }
  const normalized = normalizeAlias(repoRelativePath);
  const idx = normalized.lastIndexOf("/src/");
  if (idx >= 0) {
    return normalized.slice(0, idx + "/src/".length);
  }
  if (normalized.startsWith("src/")) {
    return "src/";
  }
  return undefined;
}

function filterRustCandidatesToSameCrate(candidates: CodeIndexEntry[], consumerPath: string | undefined): CodeIndexEntry[] {
  // Drop self-matches first so `self::macros` never resolves to the consumer itself.
  const normalizedConsumer = consumerPath ? normalizeAlias(consumerPath) : "";
  const withoutSelf = normalizedConsumer
    ? candidates.filter((entry) => normalizeAlias(entry.repoRelativePath ?? "") !== normalizedConsumer)
    : candidates;
  if (withoutSelf.length <= 1) {
    return withoutSelf;
  }

  // Standard `/src/` scoping covers Cargo's conventional layout.
  const cratePrefix = rustCrateRootPrefix(consumerPath);
  if (cratePrefix) {
    const sameCrate = withoutSelf.filter((entry) => normalizeAlias(entry.repoRelativePath ?? "").startsWith(cratePrefix));
    if (sameCrate.length > 0) {
      return sameCrate;
    }
  }

  // Fallback for non-standard layouts (e.g. ripgrep's `crates/core/*` files that live
  // outside any `/src/` tree and for integration tests under `tests/`): walk up the
  // consumer's ancestor directories and keep the narrowest set that contains at least
  // one candidate. The closest shared ancestor is by construction the Cargo crate
  // root for standard layouts and the enclosing module directory for the rest.
  if (normalizedConsumer) {
    let dir = path.posix.dirname(normalizedConsumer);
    while (dir && dir !== "." && dir !== "/") {
      const prefix = `${dir}/`;
      const sameTree = withoutSelf.filter((entry) => normalizeAlias(entry.repoRelativePath ?? "").startsWith(prefix));
      if (sameTree.length > 0) {
        return sameTree;
      }
      const parent = path.posix.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return withoutSelf;
}

// For a Rust specifier like `crate::a::b::Thing`, try matching the full path first,
// then progressively drop the trailing segment. This resolves both the module case
// (`crate::a::b` → `a/b.rs`) and the "trailing symbol" case (where `Thing` is a type
// defined in `a/b.rs`) without having to guess whether the final segment is a module
// or a symbol. Bare `crate` / `self` / `super` at the root is still looked up (so
// `crate::SymbolName` falls back to matching the current crate's `lib.rs`), but once
// the root keyword is checked and doesn't match, the loop stops.
function resolveRustAliasWithStripping(alias: string, lookup: CodeIndexLookup, consumerPath: string | undefined): CodeIndexEntry[] {
  const segments = alias.split("::");
  while (segments.length > 0) {
    const candidate = segments.join("::");
    const matches = aliasMatchesExact(lookup, candidate);
    const filtered = matches.length > 0 ? filterRustCandidatesToSameCrate(matches, consumerPath) : [];
    if (filtered.length > 0) {
      return filtered;
    }
    if (candidate === "crate" || candidate === "self" || candidate === "super") {
      break;
    }
    segments.pop();
  }
  return [];
}

function luaSpecifierLooksLocal(specifier: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:[./][A-Za-z_][A-Za-z0-9_]*)*$/.test(specifier);
}

function resolveLuaModuleCandidates(specifier: string, repoRelativePath?: string): string[] {
  const normalized = normalizeAlias(specifier.replace(/\./g, "/"));
  if (!normalized) {
    return [];
  }
  // Lua's default `package.path` is `./?.lua;./?/init.lua`. Consumers run Lua from
  // either the repo root or an embedded `src/` / `lua/` directory, and idiomatic
  // `require("pkg.mod")` references resolve against whichever is on the path. Try
  // each common "lua package root" layout — the plain form, an enclosing `src/`
  // directory, an enclosing `lua/` directory (nvim/love convention), and any ancestor
  // of the consumer file up to its package root.
  const bases = new Set<string>([normalized]);
  bases.add(`src/${normalized}`);
  bases.add(`lua/${normalized}`);
  if (repoRelativePath) {
    let dir = path.posix.dirname(repoRelativePath);
    while (dir && dir !== "." && dir !== "/") {
      bases.add(`${dir}/${normalized}`);
      const parent = path.posix.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  const candidates: string[] = [];
  for (const base of bases) {
    candidates.push(`${base}.lua`);
    candidates.push(path.posix.join(base, "init.lua"));
  }
  return uniqueBy(candidates, (item) => item);
}

function findImportCandidates(manifest: SourceManifest, codeImport: CodeImport, lookup: CodeIndexLookup): CodeIndexEntry[] {
  const language = manifest.language ?? inferCodeLanguage(manifest.originalPath ?? manifest.storedPath, manifest.mimeType);
  const repoRelativePath = manifest.repoRelativePath ? normalizeAlias(manifest.repoRelativePath) : undefined;
  if (!language) {
    return [];
  }

  switch (language) {
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx":
      return repoRelativePath && isRelativeSpecifier(codeImport.specifier)
        ? repoPathMatches(lookup, ...importResolutionCandidates(repoRelativePath, codeImport.specifier, candidateExtensionsFor(language)))
        : aliasMatches(lookup, codeImport.specifier);
    case "python":
      if (repoRelativePath && codeImport.specifier.startsWith(".")) {
        return repoPathMatches(lookup, ...resolvePythonRelativeAliases(repoRelativePath, codeImport.specifier));
      }
      return aliasMatches(lookup, codeImport.specifier);
    case "go":
    case "java":
    case "kotlin":
    case "scala":
    case "csharp":
    case "elixir":
    case "ocaml":
    case "rescript":
      return aliasMatches(lookup, codeImport.specifier);
    case "dart":
      return repoRelativePath && dartSpecifierLooksLocal(codeImport.specifier)
        ? repoPathMatches(lookup, ...importResolutionCandidates(repoRelativePath, codeImport.specifier, candidateExtensionsFor(language)))
        : aliasMatches(lookup, codeImport.specifier);
    case "lua":
      return luaSpecifierLooksLocal(codeImport.specifier)
        ? repoPathMatches(lookup, ...resolveLuaModuleCandidates(codeImport.specifier, repoRelativePath))
        : aliasMatches(lookup, codeImport.specifier, codeImport.specifier.replace(/\./g, "/"));
    case "zig":
      return repoRelativePath && (!codeImport.isExternal || codeImport.specifier.endsWith(".zig"))
        ? repoPathMatches(lookup, ...importResolutionCandidates(repoRelativePath, codeImport.specifier, candidateExtensionsFor(language)))
        : aliasMatches(lookup, codeImport.specifier);
    case "php":
    case "ruby":
    case "bash":
    case "powershell":
      if (
        repoRelativePath &&
        (language === "bash" ? bashSpecifierLooksLocal(codeImport.specifier) : isLocalIncludeSpecifier(codeImport.specifier))
      ) {
        return repoPathMatches(
          lookup,
          ...importResolutionCandidates(repoRelativePath, codeImport.specifier, candidateExtensionsFor(language))
        );
      }
      return aliasMatches(
        lookup,
        codeImport.specifier,
        codeImport.specifier.replace(/\\/g, "/"),
        stripCodeExtension(codeImport.specifier.replace(/\\/g, "/"))
      );
    case "rust": {
      for (const alias of [codeImport.specifier, ...resolveRustAliases(manifest, codeImport.specifier)]) {
        const matches = resolveRustAliasWithStripping(alias, lookup, repoRelativePath);
        if (matches.length > 0) {
          return matches;
        }
      }
      return [];
    }
    case "c":
    case "cpp":
    case "objc":
    case "solidity":
    case "html":
    case "css":
      return repoRelativePath && !codeImport.isExternal
        ? repoPathMatches(lookup, ...importResolutionCandidates(repoRelativePath, codeImport.specifier, candidateExtensionsFor(language)))
        : aliasMatches(lookup, codeImport.specifier);
    default:
      return [];
  }
}

function importLooksLocal(manifest: SourceManifest, codeImport: CodeImport, candidates: CodeIndexEntry[]): boolean {
  // A single unambiguous candidate is a strong signal that the import is local, and
  // overrides the parser's conservative default where applicable. Anything else
  // (including zero matches or an ambiguous multi-candidate name collision between
  // an external gem and some unrelated internal namespace) falls through to the
  // language-specific heuristics below.
  if (candidates.length === 1) {
    return true;
  }
  const language = manifest.language ?? inferCodeLanguage(manifest.originalPath ?? manifest.storedPath, manifest.mimeType);
  switch (language) {
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx":
      return isRelativeSpecifier(codeImport.specifier);
    case "python":
      return codeImport.specifier.startsWith(".");
    case "rust":
      return /^(crate|self|super)::/.test(codeImport.specifier);
    case "php":
    case "ruby":
    case "powershell":
    case "c":
    case "cpp":
    case "objc":
    case "kotlin":
    case "scala":
    case "solidity":
      return !codeImport.isExternal;
    case "bash":
      return bashSpecifierLooksLocal(codeImport.specifier);
    case "dart":
      return dartSpecifierLooksLocal(codeImport.specifier);
    case "lua":
      return luaSpecifierLooksLocal(codeImport.specifier);
    case "zig":
      return !codeImport.isExternal || codeImport.specifier.endsWith(".zig");
    default:
      return false;
  }
}

function resolveCodeImport(manifest: SourceManifest, codeImport: CodeImport, lookup: CodeIndexLookup): CodeImport {
  const candidates = findImportCandidates(manifest, codeImport, lookup);
  const resolved = candidates.length === 1 ? candidates[0] : undefined;
  return {
    ...codeImport,
    isExternal: importLooksLocal(manifest, codeImport, candidates) ? false : codeImport.isExternal,
    resolvedSourceId: resolved?.sourceId,
    resolvedRepoPath: resolved?.repoRelativePath
  };
}

export function enrichResolvedCodeImports(manifest: SourceManifest, analysis: SourceAnalysis, artifact: CodeIndexArtifact): SourceAnalysis {
  if (!analysis.code) {
    return analysis;
  }
  const lookup = createCodeIndexLookup(artifact);
  const imports = analysis.code.imports.map((codeImport) => resolveCodeImport(manifest, codeImport, lookup));
  return {
    ...analysis,
    code: {
      ...analysis.code,
      imports,
      dependencies: uniqueBy(
        imports.filter((item) => item.isExternal).map((item) => item.specifier),
        (specifier) => specifier
      )
    }
  };
}

export function resolveCodeImportSourceId(
  manifest: SourceManifest,
  codeImport: Pick<CodeImport, "specifier" | "isExternal" | "reExport"> & Partial<CodeImport>,
  artifact: CodeIndexArtifact
): string | undefined {
  const lookup = createCodeIndexLookup(artifact);
  return resolveCodeImport(manifest, codeImport as CodeImport, lookup).resolvedSourceId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function analyzeCodeSource(manifest: SourceManifest, extractedText: string, schemaHash: string): Promise<SourceAnalysis> {
  const language = manifest.language ?? inferCodeLanguage(manifest.originalPath ?? manifest.storedPath, manifest.mimeType) ?? "typescript";
  const { code, rationales } =
    language === "javascript" || language === "jsx" || language === "typescript" || language === "tsx"
      ? analyzeTypeScriptLikeCode(manifest, extractedText)
      : await analyzeTreeSitterCode(manifest, extractedText, language);

  return {
    analysisVersion: 7,
    sourceId: manifest.sourceId,
    sourceHash: manifest.contentHash,
    semanticHash: manifest.semanticHash,
    extractionHash: manifest.extractionHash,
    schemaHash,
    title: manifest.title,
    summary: summarizeModule(manifest, code),
    concepts: [],
    entities: [],
    claims: codeClaims(manifest, code),
    questions: codeQuestions(manifest, code),
    tags: [],
    rationales,
    code,
    producedAt: new Date().toISOString()
  };
}
