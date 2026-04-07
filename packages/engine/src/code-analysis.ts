import path from "node:path";
import ts from "typescript";
import type {
  CodeAnalysis,
  CodeDiagnostic,
  CodeImport,
  CodeLanguage,
  CodeSymbol,
  CodeSymbolKind,
  SourceAnalysis,
  SourceClaim,
  SourceManifest
} from "./types.js";
import { normalizeWhitespace, slugify, truncate, uniqueBy } from "./utils.js";

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

function makeSymbolId(sourceId: string, name: string, seen: Map<string, number>): string {
  const base = slugify(name);
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return `symbol:${sourceId}:${count === 1 ? base : `${base}-${count}`}`;
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

function finalizeCodeAnalysis(
  manifest: SourceManifest,
  language: CodeLanguage,
  imports: CodeImport[],
  draftSymbols: DraftCodeSymbol[],
  exportLabels: string[],
  diagnostics: CodeDiagnostic[]
): CodeAnalysis {
  const topLevelNames = new Set(draftSymbols.map((symbol) => symbol.name));
  for (const symbol of draftSymbols) {
    if (symbol.callNames.length === 0 && symbol.bodyText) {
      symbol.callNames = collectCallNamesFromText(symbol.bodyText, topLevelNames, symbol.name);
    }
  }

  const seenSymbolIds = new Map<string, number>();
  const symbols: CodeSymbol[] = draftSymbols.map((symbol) => ({
    id: makeSymbolId(manifest.sourceId, symbol.name, seenSymbolIds),
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

function analyzePythonCode(manifest: SourceManifest, content: string): CodeAnalysis {
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

function analyzeGoCode(manifest: SourceManifest, content: string): CodeAnalysis {
  const lines = splitLines(content);
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const diagnostics: CodeDiagnostic[] = [];

  let inImportBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//")) {
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
        kind: typeMatch[2] === "interface" ? "interface" : "class",
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

  return finalizeCodeAnalysis(manifest, "go", imports, draftSymbols, exportLabels, diagnostics);
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

function analyzeRustCode(manifest: SourceManifest, content: string): CodeAnalysis {
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
        kind: "class",
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
        kind: "interface",
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
      kind: "interface",
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

function analyzeJavaCode(manifest: SourceManifest, content: string): CodeAnalysis {
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

  return finalizeCodeAnalysis(manifest, "java", imports, draftSymbols, exportLabels, diagnostics);
}

function analyzeTypeScriptLikeCode(manifest: SourceManifest, content: string): CodeAnalysis {
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

  return finalizeCodeAnalysis(manifest, language, imports, draftSymbols, exportLabels, diagnostics);
}

export function inferCodeLanguage(filePath: string, mimeType = ""): CodeLanguage | undefined {
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
  return undefined;
}

export function modulePageTitle(manifest: SourceManifest): string {
  return `${manifest.title} module`;
}

function importResolutionCandidates(basePath: string, specifier: string, extensions: string[]): string[] {
  const resolved = path.resolve(path.dirname(basePath), specifier);
  if (path.extname(resolved)) {
    return [path.normalize(resolved)];
  }

  const direct = extensions.map((extension) => path.normalize(`${resolved}${extension}`));
  const indexFiles = extensions.map((extension) => path.normalize(path.join(resolved, `index${extension}`)));
  return uniqueBy([path.normalize(resolved), ...direct, ...indexFiles], (candidate) => candidate);
}

function resolveJsLikeImportSourceId(manifest: SourceManifest, specifier: string, manifests: SourceManifest[]): string | undefined {
  if (manifest.originType !== "file" || !manifest.originalPath || !isRelativeSpecifier(specifier)) {
    return undefined;
  }

  const candidates = new Set(
    importResolutionCandidates(manifest.originalPath, specifier, [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"])
  );
  return manifests.find(
    (candidate) => candidate.sourceKind === "code" && candidate.originalPath && candidates.has(path.normalize(candidate.originalPath))
  )?.sourceId;
}

function resolvePythonImportSourceId(manifest: SourceManifest, specifier: string, manifests: SourceManifest[]): string | undefined {
  if (manifest.originType !== "file" || !manifest.originalPath) {
    return undefined;
  }

  if (specifier.startsWith(".")) {
    const dotMatch = specifier.match(/^\.+/);
    const depth = dotMatch ? dotMatch[0].length : 0;
    const relativeModule = specifier.slice(depth).replace(/\./g, "/");
    const baseDir = path.dirname(manifest.originalPath);
    const parentDir = path.resolve(baseDir, ...Array(Math.max(depth - 1, 0)).fill(".."));
    const moduleBase = relativeModule ? path.join(parentDir, relativeModule) : parentDir;
    const candidates = new Set([path.normalize(`${moduleBase}.py`), path.normalize(path.join(moduleBase, "__init__.py"))]);
    return manifests.find(
      (candidate) => candidate.sourceKind === "code" && candidate.originalPath && candidates.has(path.normalize(candidate.originalPath))
    )?.sourceId;
  }

  const modulePath = specifier.replace(/\./g, "/");
  const suffixes = [`/${modulePath}.py`, `/${modulePath}/__init__.py`];
  return manifests.find((candidate) => {
    if (candidate.sourceKind !== "code" || !candidate.originalPath) {
      return false;
    }
    const normalizedOriginalPath = path.normalize(candidate.originalPath);
    return suffixes.some((suffix) => normalizedOriginalPath.endsWith(path.normalize(suffix)));
  })?.sourceId;
}

export function resolveCodeImportSourceId(manifest: SourceManifest, specifier: string, manifests: SourceManifest[]): string | undefined {
  const language = manifest.language ?? inferCodeLanguage(manifest.originalPath ?? manifest.storedPath, manifest.mimeType);
  switch (language) {
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx":
      return resolveJsLikeImportSourceId(manifest, specifier, manifests);
    case "python":
      return resolvePythonImportSourceId(manifest, specifier, manifests);
    default:
      return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function analyzeCodeSource(manifest: SourceManifest, extractedText: string, schemaHash: string): SourceAnalysis {
  const language = manifest.language ?? inferCodeLanguage(manifest.originalPath ?? manifest.storedPath, manifest.mimeType) ?? "typescript";
  const code =
    language === "python"
      ? analyzePythonCode(manifest, extractedText)
      : language === "go"
        ? analyzeGoCode(manifest, extractedText)
        : language === "rust"
          ? analyzeRustCode(manifest, extractedText)
          : language === "java"
            ? analyzeJavaCode(manifest, extractedText)
            : analyzeTypeScriptLikeCode(manifest, extractedText);

  return {
    sourceId: manifest.sourceId,
    sourceHash: manifest.contentHash,
    schemaHash,
    title: manifest.title,
    summary: summarizeModule(manifest, code),
    concepts: [],
    entities: [],
    claims: codeClaims(manifest, code),
    questions: codeQuestions(manifest, code),
    code,
    producedAt: new Date().toISOString()
  };
}
