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
  return specifier.startsWith("./") || specifier.startsWith("../");
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

function analyzeTopLevelCode(manifest: SourceManifest, content: string): CodeAnalysis {
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

  const seenSymbolIds = new Map<string, number>();
  const symbols: CodeSymbol[] = draftSymbols.map((symbol) => ({
    id: makeSymbolId(manifest.sourceId, symbol.name, seenSymbolIds),
    name: symbol.name,
    kind: symbol.kind,
    signature: symbol.signature,
    exported: symbol.exported || localExportNames.has(symbol.name),
    calls: symbol.callNames,
    extends: symbol.extendsNames,
    implements: symbol.implementsNames
  }));

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

export function inferCodeLanguage(filePath: string, mimeType = ""): CodeLanguage | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts") {
    return "typescript";
  }
  if (extension === ".tsx") {
    return "tsx";
  }
  if (extension === ".jsx") {
    return "jsx";
  }
  if (extension === ".js" || mimeType.includes("javascript")) {
    return "javascript";
  }
  return undefined;
}

export function modulePageTitle(manifest: SourceManifest): string {
  return `${manifest.title} module`;
}

function importResolutionCandidates(basePath: string, specifier: string): string[] {
  const resolved = path.resolve(path.dirname(basePath), specifier);
  if (path.extname(resolved)) {
    return [path.normalize(resolved)];
  }

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  const direct = extensions.map((extension) => path.normalize(`${resolved}${extension}`));
  const indexFiles = extensions.map((extension) => path.normalize(path.join(resolved, `index${extension}`)));
  return uniqueBy([path.normalize(resolved), ...direct, ...indexFiles], (candidate) => candidate);
}

export function resolveCodeImportSourceId(manifest: SourceManifest, specifier: string, manifests: SourceManifest[]): string | undefined {
  if (manifest.originType !== "file" || !manifest.originalPath || !isRelativeSpecifier(specifier)) {
    return undefined;
  }

  const candidates = new Set(importResolutionCandidates(manifest.originalPath, specifier));
  return manifests.find(
    (candidate) => candidate.sourceKind === "code" && candidate.originalPath && candidates.has(path.normalize(candidate.originalPath))
  )?.sourceId;
}

export function analyzeCodeSource(manifest: SourceManifest, extractedText: string, schemaHash: string): SourceAnalysis {
  const code = analyzeTopLevelCode(manifest, extractedText);

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
