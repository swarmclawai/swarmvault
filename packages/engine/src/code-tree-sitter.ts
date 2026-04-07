import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  CodeAnalysis,
  CodeDiagnostic,
  CodeImport,
  CodeLanguage,
  CodeSymbol,
  CodeSymbolKind,
  SourceManifest,
  SourceRationale
} from "./types.js";
import { normalizeWhitespace, slugify, toPosix, truncate, uniqueBy } from "./utils.js";

const require = createRequire(import.meta.url);
const TREE_SITTER_PACKAGE_ROOT = path.dirname(path.dirname(require.resolve("@vscode/tree-sitter-wasm")));

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

type TreePoint = {
  row: number;
  column: number;
};

type TreeNode = {
  type: string;
  text: string;
  isError: boolean;
  isMissing: boolean;
  hasError: boolean;
  startPosition: TreePoint;
  children: Array<TreeNode | null>;
  namedChildren: Array<TreeNode | null>;
  childForFieldName(fieldName: string): TreeNode | null;
  descendantsOfType(types: string | string[]): Array<TreeNode | null>;
};

type Tree = {
  rootNode: TreeNode;
  delete(): void;
};

type TreeLanguage = {
  name: string | null;
};

type TreeParser = {
  setLanguage(language: TreeLanguage | null): void;
  parse(source: string): Tree | null;
};

const RATIONALE_MARKERS = ["NOTE:", "IMPORTANT:", "HACK:", "WHY:", "RATIONALE:"];

function stripKnownCommentPrefix(line: string): string {
  let next = line.trim();
  for (const prefix of ["/**", "/*", "*/", "//", "#", "--", "*"]) {
    if (next.startsWith(prefix)) {
      next = next.slice(prefix.length).trimStart();
    }
  }
  return next;
}

type TreeSitterModule = {
  Parser: {
    init(moduleOptions?: { locateFile: (_file: string, _folder: string) => string }): Promise<void>;
    new (): TreeParser;
  };
  Language: {
    load(input: Uint8Array): Promise<TreeLanguage>;
  };
};

let treeSitterModulePromise: Promise<TreeSitterModule> | undefined;
let treeSitterInitPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<TreeLanguage>>();

const grammarFileByLanguage: Record<Exclude<CodeLanguage, "javascript" | "jsx" | "typescript" | "tsx">, string> = {
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c-sharp.wasm",
  c: "tree-sitter-cpp.wasm",
  cpp: "tree-sitter-cpp.wasm",
  php: "tree-sitter-php.wasm"
};

async function getTreeSitterModule(): Promise<TreeSitterModule> {
  if (!treeSitterModulePromise) {
    treeSitterModulePromise = import(require.resolve("@vscode/tree-sitter-wasm")).then(
      (module) => (module.default ?? module) as TreeSitterModule
    );
  }
  return treeSitterModulePromise;
}

async function ensureTreeSitterInit(module: TreeSitterModule): Promise<void> {
  if (!treeSitterInitPromise) {
    treeSitterInitPromise = module.Parser.init({
      locateFile: () => path.join(TREE_SITTER_PACKAGE_ROOT, "wasm", "tree-sitter.wasm")
    });
  }
  return treeSitterInitPromise;
}

async function loadLanguage(language: Exclude<CodeLanguage, "javascript" | "jsx" | "typescript" | "tsx">): Promise<TreeLanguage> {
  const cached = languageCache.get(language);
  if (cached) {
    return cached;
  }

  const loader = (async () => {
    const module = await getTreeSitterModule();
    await ensureTreeSitterInit(module);
    const bytes = await fs.readFile(path.join(TREE_SITTER_PACKAGE_ROOT, "wasm", grammarFileByLanguage[language]));
    return module.Language.load(bytes);
  })();

  languageCache.set(language, loader);
  return loader;
}

function normalizeSymbolReference(value: string): string {
  const withoutGenerics = value.replace(/<[^>]*>/g, "");
  const withoutDecorators = withoutGenerics.replace(/['"&*()[\]{}]/g, " ");
  const trimmed = withoutDecorators.trim();
  const lastSegment =
    trimmed
      .split(/::|\\|\.|->/)
      .filter(Boolean)
      .at(-1) ?? trimmed;
  return lastSegment.replace(/[,:;]+$/g, "").trim();
}

function stripCodeExtension(filePath: string): string {
  return filePath.replace(/\.(?:[cm]?jsx?|tsx?|mts|cts|py|go|rs|java|cs|php|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, "");
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

function singleLineSignature(value: string): string {
  return truncate(
    normalizeWhitespace(
      value
        .replace(/\{\s*$/, "")
        .replace(/:\s*$/, ":")
        .trim()
    ),
    180
  );
}

function makeSymbolId(sourceId: string, name: string, seen: Map<string, number>): string {
  const base = slugify(name);
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return `symbol:${sourceId}:${count === 1 ? base : `${base}-${count}`}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function cleanCommentText(value: string): string {
  return normalizeWhitespace(
    value
      .split(/\r?\n/)
      .map((line) => stripKnownCommentPrefix(line))
      .join("\n")
      .trim()
  );
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

function rationaleKindFromText(text: string): SourceRationale["kind"] {
  const upper = text.toUpperCase();
  return RATIONALE_MARKERS.some((marker) => upper.startsWith(marker)) ? "marker" : "comment";
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

function nodeText(node: TreeNode | null | undefined): string {
  return node?.text ?? "";
}

function moduleDocstringNode(rootNode: TreeNode): TreeNode | null {
  const first = rootNode.namedChildren[0];
  if (!first || first.type !== "expression_statement") {
    return null;
  }
  return first.namedChildren.find((child) => child?.type === "string" || child?.type === "concatenated_string") ?? null;
}

function bodyDocstringNode(node: TreeNode | null | undefined): TreeNode | null {
  const body = node?.childForFieldName("body");
  if (!body) {
    return null;
  }
  const first = body.namedChildren[0];
  if (!first || first.type !== "expression_statement") {
    return null;
  }
  return first.namedChildren.find((child) => child?.type === "string" || child?.type === "concatenated_string") ?? null;
}

function unquoteDocstringText(value: string): string {
  return value
    .trim()
    .replace(/^("""|'''|"|')/, "")
    .replace(/("""|'''|"|')$/, "");
}

function commentNodes(rootNode: TreeNode): TreeNode[] {
  return rootNode.descendantsOfType("comment").filter((node): node is TreeNode => node !== null);
}

function extractTreeSitterRationales(
  manifest: SourceManifest,
  language: Exclude<CodeLanguage, "javascript" | "jsx" | "typescript" | "tsx">,
  rootNode: TreeNode
): SourceRationale[] {
  const results: SourceRationale[] = [];
  let index = 0;
  const push = (text: string, kind: SourceRationale["kind"], symbolName?: string) => {
    const rationale = makeRationale(manifest, index + 1, text, kind, symbolName);
    if (rationale) {
      results.push(rationale);
      index += 1;
    }
  };

  if (language === "python") {
    const moduleDocstring = moduleDocstringNode(rootNode);
    if (moduleDocstring) {
      push(unquoteDocstringText(moduleDocstring.text), "docstring");
    }
    for (const node of rootNode
      .descendantsOfType(["class_definition", "function_definition"])
      .filter((item): item is TreeNode => item !== null)) {
      const name = extractIdentifier(node.childForFieldName("name"));
      const docstring = bodyDocstringNode(node);
      if (docstring) {
        push(unquoteDocstringText(docstring.text), "docstring", name);
      }
    }
  }

  for (const commentNode of commentNodes(rootNode)) {
    push(commentNode.text, rationaleKindFromText(commentNode.text));
  }

  return uniqueBy(results, (item) => `${item.symbolName ?? ""}:${item.text.toLowerCase()}`);
}

function findNamedChild(node: TreeNode | null | undefined, type: string): TreeNode | null {
  return node?.namedChildren.find((child) => child?.type === type) ?? null;
}

function extractIdentifier(node: TreeNode | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (["identifier", "field_identifier", "type_identifier", "name", "package_identifier"].includes(node.type)) {
    return node.text.trim();
  }
  const preferred =
    node.childForFieldName("name") ??
    node.namedChildren.find(
      (child) => child && ["identifier", "field_identifier", "type_identifier", "name", "package_identifier"].includes(child.type)
    ) ??
    node.namedChildren.at(-1) ??
    null;
  return preferred ? extractIdentifier(preferred) : undefined;
}

function exportedByCapitalization(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function parseCommaSeparatedReferences(value: string): string[] {
  return uniqueBy(
    value
      .split(",")
      .map((item) => item.replace(/\b(public|private|protected|internal|virtual|sealed|static|readonly|new|abstract|final)\b/g, "").trim())
      .map((item) => normalizeSymbolReference(item))
      .filter(Boolean),
    (item) => item
  );
}

function descendantTypeNames(node: TreeNode | null | undefined): string[] {
  if (!node) {
    return [];
  }
  return uniqueBy(
    node
      .descendantsOfType(["type_identifier", "identifier", "name"])
      .filter((item): item is TreeNode => item !== null)
      .map((item) => normalizeSymbolReference(item.text))
      .filter(Boolean),
    (item) => item
  );
}

function quotedPath(value: string): string {
  return value.replace(/^["'<]+|[">]+$/g, "").trim();
}

function diagnosticsFromTree(rootNode: TreeNode): CodeDiagnostic[] {
  if (!rootNode.hasError) {
    return [];
  }

  const diagnostics: CodeDiagnostic[] = [];
  const seen = new Set<string>();
  const visit = (node: TreeNode | null) => {
    if (!node) {
      return;
    }

    if (node.isError || node.isMissing) {
      const key = `${node.startPosition.row}:${node.startPosition.column}:${node.type}:${node.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push({
          code: node.isMissing ? 9002 : 9001,
          category: "error",
          message: node.isMissing
            ? `Missing ${node.type} near \`${truncate(normalizeWhitespace(node.text), 80)}\`.`
            : `Syntax error near \`${truncate(normalizeWhitespace(node.text), 80)}\`.`,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1
        });
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  visit(rootNode);
  return diagnostics.slice(0, 20);
}

function parsePythonImportStatement(text: string): CodeImport[] {
  const match = text.trim().match(/^import\s+(.+)$/);
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [specifier, alias] = item.split(/\s+as\s+/i);
      return {
        specifier: specifier.trim(),
        importedSymbols: [],
        namespaceImport: alias?.trim(),
        isExternal: !specifier.trim().startsWith("."),
        reExport: false
      } satisfies CodeImport;
    });
}

function parsePythonFromImportStatement(text: string): CodeImport[] {
  const match = text.trim().match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
  if (!match) {
    return [];
  }

  return [
    {
      specifier: match[1],
      importedSymbols: match[2]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      isExternal: !match[1].startsWith("."),
      reExport: false
    }
  ];
}

function parseGoImport(text: string): CodeImport | undefined {
  const match = text.trim().match(/^(?:([._A-Za-z]\w*)\s+)?"([^"]+)"$/);
  if (!match) {
    return undefined;
  }

  return {
    specifier: match[2],
    importedSymbols: [],
    namespaceImport: match[1] && ![".", "_"].includes(match[1]) ? match[1] : undefined,
    isExternal: !match[2].startsWith("."),
    reExport: false
  };
}

function parseRustUse(text: string): CodeImport {
  const cleaned = text
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
    reExport: text.trim().startsWith("pub use ")
  };
}

function parseJavaImport(text: string): CodeImport {
  const cleaned = text
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

function parseCSharpUsing(text: string): CodeImport | undefined {
  const aliasMatch = text.trim().match(/^using\s+([A-Za-z_]\w*)\s*=\s*([^;]+);$/);
  if (aliasMatch) {
    return {
      specifier: aliasMatch[2].trim(),
      importedSymbols: [],
      namespaceImport: aliasMatch[1],
      isExternal: !aliasMatch[2].trim().startsWith("."),
      reExport: false
    };
  }

  const match = text.trim().match(/^using\s+([^;]+);$/);
  if (!match) {
    return undefined;
  }

  return {
    specifier: match[1].trim(),
    importedSymbols: [],
    isExternal: !match[1].trim().startsWith("."),
    reExport: false
  };
}

function parsePhpUse(text: string): CodeImport[] {
  const cleaned = text
    .trim()
    .replace(/^use\s+/, "")
    .replace(/;$/, "");
  return cleaned
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const aliasMatch = item.match(/^(.+?)\s+as\s+([A-Za-z_]\w*)$/i);
      const specifier = (aliasMatch ? aliasMatch[1] : item).trim();
      return {
        specifier,
        importedSymbols: [],
        namespaceImport: aliasMatch?.[2],
        isExternal: !specifier.startsWith("."),
        reExport: false
      } satisfies CodeImport;
    });
}

function parseCppInclude(text: string): CodeImport | undefined {
  const match = text.trim().match(/^#include\s+([<"].+[>"])$/);
  if (!match) {
    return undefined;
  }
  const specifier = quotedPath(match[1]);
  return {
    specifier,
    importedSymbols: [],
    isExternal: match[1].startsWith("<"),
    reExport: false
  };
}

function pythonCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "import_statement") {
      imports.push(...parsePythonImportStatement(child.text));
      continue;
    }
    if (child.type === "import_from_statement") {
      imports.push(...parsePythonFromImportStatement(child.text));
      continue;
    }
    if (child.type === "class_definition") {
      const name = extractIdentifier(child.childForFieldName("name"));
      if (!name) {
        continue;
      }
      const superclasses = parseCommaSeparatedReferences(nodeText(child.childForFieldName("superclasses")).replace(/^\(|\)$/g, ""));
      draftSymbols.push({
        name,
        kind: "class",
        signature: singleLineSignature(child.text),
        exported: !name.startsWith("_"),
        callNames: [],
        extendsNames: superclasses,
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body"))
      });
      continue;
    }
    if (child.type === "function_definition") {
      const name = extractIdentifier(child.childForFieldName("name"));
      if (!name) {
        continue;
      }
      draftSymbols.push({
        name,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported: !name.startsWith("_"),
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body"))
      });
    }
  }
  return finalizeCodeAnalysis(manifest, "python", imports, draftSymbols, [], diagnostics);
}

function goCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  let packageName: string | undefined;

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "package_clause") {
      packageName = extractIdentifier(child.namedChildren.at(0) ?? null);
      continue;
    }
    if (child.type === "import_declaration") {
      for (const spec of child.descendantsOfType("import_spec")) {
        const parsed = spec ? parseGoImport(spec.text) : undefined;
        if (parsed) {
          imports.push(parsed);
        }
      }
      continue;
    }
    if (child.type === "type_declaration") {
      for (const spec of child.descendantsOfType("type_spec")) {
        if (!spec) {
          continue;
        }
        const name = extractIdentifier(spec.childForFieldName("name"));
        const typeNode = spec.childForFieldName("type");
        if (!name || !typeNode) {
          continue;
        }
        const kind: CodeSymbolKind =
          typeNode.type === "struct_type" ? "struct" : typeNode.type === "interface_type" ? "interface" : "type_alias";
        const exported = exportedByCapitalization(name);
        draftSymbols.push({
          name,
          kind,
          signature: singleLineSignature(spec.text),
          exported,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: typeNode.text
        });
        if (exported) {
          exportLabels.push(name);
        }
      }
      continue;
    }
    if (child.type === "function_declaration" || child.type === "method_declaration") {
      const name = extractIdentifier(child.childForFieldName("name"));
      if (!name) {
        continue;
      }
      const receiverType =
        child.type === "method_declaration"
          ? normalizeSymbolReference(nodeText(child.childForFieldName("receiver")).replace(/[()]/g, " ").split(/\s+/).at(-1) ?? "")
          : "";
      const symbolName = receiverType ? `${receiverType}.${name}` : name;
      const exported = exportedByCapitalization(name);
      draftSymbols.push({
        name: symbolName,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body"))
      });
      if (exported) {
        exportLabels.push(symbolName);
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "go", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: packageName
  });
}

function rustCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const symbolsByName = new Map<string, DraftCodeSymbol>();

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "use_declaration") {
      imports.push(parseRustUse(child.text));
      continue;
    }

    const name =
      child.type === "function_item"
        ? extractIdentifier(child.childForFieldName("name"))
        : extractIdentifier(child.childForFieldName("name"));

    if (child.type === "impl_item") {
      const traitName = normalizeSymbolReference(nodeText(child.childForFieldName("trait")));
      const typeName = normalizeSymbolReference(nodeText(child.childForFieldName("type")));
      const target = symbolsByName.get(typeName);
      if (target && traitName) {
        target.implementsNames.push(traitName);
      }
      continue;
    }

    if (!name) {
      continue;
    }

    let kind: CodeSymbolKind | undefined;
    let extendsNames: string[] = [];
    if (child.type === "struct_item") {
      kind = "struct";
    } else if (child.type === "trait_item") {
      kind = "trait";
      extendsNames = parseCommaSeparatedReferences(nodeText(child.childForFieldName("bounds")).replace(/\+/g, ","));
    } else if (child.type === "enum_item") {
      kind = "enum";
    } else if (child.type === "function_item") {
      kind = "function";
    } else if (child.type === "type_item") {
      kind = "type_alias";
    } else if (child.type === "const_item" || child.type === "static_item") {
      kind = "variable";
    }

    if (!kind) {
      continue;
    }

    const exported = child.namedChildren.some((item) => item?.type === "visibility_modifier");
    const symbol: DraftCodeSymbol = {
      name,
      kind,
      signature: singleLineSignature(child.text),
      exported,
      callNames: [],
      extendsNames,
      implementsNames: [],
      bodyText: nodeText(child.childForFieldName("body")) || child.text
    };
    draftSymbols.push(symbol);
    symbolsByName.set(name, symbol);
    if (exported) {
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "rust", imports, draftSymbols, exportLabels, diagnostics);
}

function javaCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  let packageName: string | undefined;

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "package_declaration") {
      packageName = child.text
        .replace(/^package\s+/, "")
        .replace(/;$/, "")
        .trim();
      continue;
    }
    if (child.type === "import_declaration") {
      imports.push(parseJavaImport(child.text));
      continue;
    }

    const name = extractIdentifier(child.childForFieldName("name"));
    if (!name) {
      continue;
    }

    let kind: CodeSymbolKind | undefined;
    let extendsNames: string[] = [];
    let implementsNames: string[] = [];
    if (child.type === "class_declaration") {
      kind = "class";
      extendsNames = descendantTypeNames(child.childForFieldName("superclass"));
      implementsNames = descendantTypeNames(child.childForFieldName("interfaces"));
    } else if (child.type === "interface_declaration") {
      kind = "interface";
      extendsNames = descendantTypeNames(
        child.descendantsOfType("extends_interfaces").find((item): item is TreeNode => item !== null) ?? null
      );
    } else if (child.type === "enum_declaration") {
      kind = "enum";
    }

    if (!kind) {
      continue;
    }

    const exported = /\bpublic\b/.test(child.text);
    draftSymbols.push({
      name,
      kind,
      signature: singleLineSignature(child.text),
      exported,
      callNames: [],
      extendsNames,
      implementsNames,
      bodyText: nodeText(child.childForFieldName("body")) || child.text
    });
    if (exported) {
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "java", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: packageName
  });
}

function csharpCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  let namespaceName: string | undefined;

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "using_directive") {
      const parsed = parseCSharpUsing(child.text);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }
    if (child.type === "file_scoped_namespace_declaration" || child.type === "namespace_declaration") {
      namespaceName = nodeText(child.childForFieldName("name")) || namespaceName;
      if (child.type === "namespace_declaration") {
        for (const nested of child.namedChildren) {
          if (nested && nested !== child.childForFieldName("name")) {
            // Top-level declarations inside block namespaces still belong to the file namespace.
            if (
              ["class_declaration", "interface_declaration", "enum_declaration", "struct_declaration", "record_declaration"].includes(
                nested.type
              )
            ) {
              const nestedName = extractIdentifier(nested.childForFieldName("name"));
              if (!nestedName) {
                continue;
              }
              const effectiveBaseList = parseCommaSeparatedReferences(
                nodeText(findNamedChild(nested, "base_list") ?? nested.childForFieldName("base_list")).replace(/^:/, "")
              );
              const kind: CodeSymbolKind =
                nested.type === "interface_declaration"
                  ? "interface"
                  : nested.type === "enum_declaration"
                    ? "enum"
                    : nested.type === "struct_declaration"
                      ? "struct"
                      : "class";
              const exported = /\b(public|internal|protected)\b/.test(nested.text);
              const extendsNames = kind === "class" || kind === "struct" ? effectiveBaseList.slice(0, 1) : [];
              const implementsNames =
                kind === "interface" ? [] : kind === "enum" ? [] : effectiveBaseList.slice(kind === "class" || kind === "struct" ? 1 : 0);
              draftSymbols.push({
                name: nestedName,
                kind,
                signature: singleLineSignature(nested.text),
                exported,
                callNames: [],
                extendsNames,
                implementsNames,
                bodyText: nodeText(nested.childForFieldName("body")) || nested.text
              });
              if (exported) {
                exportLabels.push(nestedName);
              }
            }
          }
        }
      }
      if (child.type === "namespace_declaration") {
        continue;
      }
    }

    if (
      !["class_declaration", "interface_declaration", "enum_declaration", "struct_declaration", "record_declaration"].includes(child.type)
    ) {
      continue;
    }

    const name = extractIdentifier(child.childForFieldName("name"));
    if (!name) {
      continue;
    }
    const baseList = parseCommaSeparatedReferences(
      nodeText(findNamedChild(child, "base_list") ?? child.childForFieldName("base_list")).replace(/^:/, "")
    );
    const kind: CodeSymbolKind =
      child.type === "interface_declaration"
        ? "interface"
        : child.type === "enum_declaration"
          ? "enum"
          : child.type === "struct_declaration"
            ? "struct"
            : "class";
    const exported = /\b(public|internal|protected)\b/.test(child.text);
    const extendsNames = kind === "class" || kind === "struct" ? baseList.slice(0, 1) : [];
    const implementsNames =
      kind === "interface" ? [] : kind === "enum" ? [] : baseList.slice(kind === "class" || kind === "struct" ? 1 : 0);
    draftSymbols.push({
      name,
      kind,
      signature: singleLineSignature(child.text),
      exported,
      callNames: [],
      extendsNames,
      implementsNames,
      bodyText: nodeText(child.childForFieldName("body")) || child.text
    });
    if (exported) {
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "csharp", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: namespaceName
  });
}

function phpCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  let namespaceName: string | undefined;

  for (const child of rootNode.namedChildren) {
    if (!child || child.type === "php_tag") {
      continue;
    }
    if (child.type === "namespace_definition") {
      namespaceName = nodeText(child.childForFieldName("name")) || namespaceName;
      continue;
    }
    if (child.type === "namespace_use_declaration") {
      imports.push(...parsePhpUse(child.text));
      continue;
    }

    const name = extractIdentifier(child.childForFieldName("name"));
    if (!name) {
      continue;
    }
    let kind: CodeSymbolKind | undefined;
    let extendsNames: string[] = [];
    let implementsNames: string[] = [];
    if (child.type === "class_declaration") {
      kind = "class";
      extendsNames = parseCommaSeparatedReferences(
        nodeText(findNamedChild(child, "base_clause") ?? child.childForFieldName("base_clause"))
      );
      implementsNames = parseCommaSeparatedReferences(
        nodeText(findNamedChild(child, "class_interface_clause") ?? child.childForFieldName("class_interface_clause"))
      );
    } else if (child.type === "interface_declaration") {
      kind = "interface";
      extendsNames = parseCommaSeparatedReferences(
        nodeText(findNamedChild(child, "base_clause") ?? child.childForFieldName("base_clause"))
      );
    } else if (child.type === "trait_declaration") {
      kind = "trait";
    } else if (child.type === "enum_declaration") {
      kind = "enum";
    } else if (child.type === "function_definition") {
      kind = "function";
    }

    if (!kind) {
      continue;
    }

    draftSymbols.push({
      name,
      kind,
      signature: singleLineSignature(child.text),
      exported: true,
      callNames: [],
      extendsNames,
      implementsNames,
      bodyText: nodeText(child.childForFieldName("body")) || child.text
    });
    exportLabels.push(name);
  }

  return finalizeCodeAnalysis(manifest, "php", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: namespaceName
  });
}

function cFamilyCodeAnalysis(
  manifest: SourceManifest,
  language: "c" | "cpp",
  rootNode: TreeNode,
  diagnostics: CodeDiagnostic[]
): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  const functionNameFromDeclarator = (node: TreeNode | null | undefined): string | undefined => {
    if (!node) {
      return undefined;
    }
    const declarator = node.childForFieldName("declarator");
    if (declarator) {
      return functionNameFromDeclarator(declarator);
    }
    return extractIdentifier(node);
  };

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "preproc_include") {
      const parsed = parseCppInclude(child.text);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    if (["class_specifier", "struct_specifier", "enum_specifier"].includes(child.type)) {
      const name = extractIdentifier(child.childForFieldName("name"));
      if (!name) {
        continue;
      }
      const kind: CodeSymbolKind = child.type === "enum_specifier" ? "enum" : child.type === "struct_specifier" ? "struct" : "class";
      const baseClassClause = findNamedChild(child, "base_class_clause") ?? child.childForFieldName("base_class_clause");
      const bases = baseClassClause
        ? uniqueBy(
            baseClassClause.namedChildren
              .filter((item): item is TreeNode => item !== null && item.type !== "access_specifier")
              .map((item) => normalizeSymbolReference(item.text.replace(/\b(public|private|protected|virtual)\b/g, "").trim()))
              .filter(Boolean),
            (item) => item
          )
        : [];
      const exported = !/\bstatic\b/.test(child.text);
      draftSymbols.push({
        name,
        kind,
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: bases,
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body")) || child.text
      });
      if (exported) {
        exportLabels.push(name);
      }
      continue;
    }

    if (child.type === "function_definition") {
      const name = functionNameFromDeclarator(child.childForFieldName("declarator"));
      if (!name) {
        continue;
      }
      const exported = !/\bstatic\b/.test(child.text);
      draftSymbols.push({
        name,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body")) || child.text
      });
      if (exported) {
        exportLabels.push(name);
      }
    }
  }

  return finalizeCodeAnalysis(manifest, language, imports, draftSymbols, exportLabels, diagnostics);
}

export async function analyzeTreeSitterCode(
  manifest: SourceManifest,
  content: string,
  language: Exclude<CodeLanguage, "javascript" | "jsx" | "typescript" | "tsx">
): Promise<{
  code: CodeAnalysis;
  rationales: SourceRationale[];
}> {
  const module = await getTreeSitterModule();
  await ensureTreeSitterInit(module);
  const parser = new module.Parser();
  parser.setLanguage(await loadLanguage(language));
  const tree = parser.parse(content);
  if (!tree) {
    return {
      code: finalizeCodeAnalysis(
        manifest,
        language,
        [],
        [],
        [],
        [
          {
            code: 9000,
            category: "error",
            message: `Failed to parse ${language} source.`,
            line: 1,
            column: 1
          }
        ]
      ),
      rationales: []
    };
  }

  try {
    const diagnostics = diagnosticsFromTree(tree.rootNode);
    const rationales = extractTreeSitterRationales(manifest, language, tree.rootNode);
    switch (language) {
      case "python":
        return { code: pythonCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "go":
        return { code: goCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "rust":
        return { code: rustCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "java":
        return { code: javaCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "csharp":
        return { code: csharpCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "php":
        return { code: phpCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "c":
      case "cpp":
        return { code: cFamilyCodeAnalysis(manifest, language, tree.rootNode, diagnostics), rationales };
    }
  } finally {
    tree.delete();
  }
}
