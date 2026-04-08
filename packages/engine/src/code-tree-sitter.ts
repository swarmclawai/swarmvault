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
const TREE_SITTER_RUNTIME_PACKAGE = "@vscode/tree-sitter-wasm";
const TREE_SITTER_EXTRA_GRAMMARS_PACKAGE = "tree-sitter-wasms";
const packageRootCache = new Map<string, string>();

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

type GoReceiverBinding = {
  typeName?: string;
  variableName?: string;
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

type TreeSitterGrammarAsset = {
  packageName: string;
  relativePath: string;
};

const grammarAssetByLanguage: Record<Exclude<CodeLanguage, "javascript" | "jsx" | "typescript" | "tsx">, TreeSitterGrammarAsset> = {
  python: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-python.wasm" },
  go: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-go.wasm" },
  rust: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-rust.wasm" },
  java: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-java.wasm" },
  kotlin: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-kotlin.wasm" },
  scala: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-scala.wasm" },
  lua: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-lua.wasm" },
  zig: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-zig.wasm" },
  csharp: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-c-sharp.wasm" },
  c: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-cpp.wasm" },
  cpp: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-cpp.wasm" },
  php: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-php.wasm" },
  ruby: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-ruby.wasm" },
  powershell: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-powershell.wasm" }
};

function resolvePackageRoot(packageName: string): string {
  const cached = packageRootCache.get(packageName);
  if (cached) {
    return cached;
  }
  let resolved: string;
  try {
    resolved = path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    resolved = path.dirname(path.dirname(require.resolve(packageName)));
  }
  packageRootCache.set(packageName, resolved);
  return resolved;
}

function grammarAssetPath(language: Exclude<CodeLanguage, "javascript" | "jsx" | "typescript" | "tsx">): string {
  const asset = grammarAssetByLanguage[language];
  return path.join(resolvePackageRoot(asset.packageName), asset.relativePath);
}

async function getTreeSitterModule(): Promise<TreeSitterModule> {
  if (!treeSitterModulePromise) {
    treeSitterModulePromise = import(require.resolve(TREE_SITTER_RUNTIME_PACKAGE)).then(
      (module) => (module.default ?? module) as TreeSitterModule
    );
  }
  return treeSitterModulePromise;
}

async function ensureTreeSitterInit(module: TreeSitterModule): Promise<void> {
  if (!treeSitterInitPromise) {
    const runtimeRoot = resolvePackageRoot(TREE_SITTER_RUNTIME_PACKAGE);
    treeSitterInitPromise = module.Parser.init({
      locateFile: () => path.join(runtimeRoot, "wasm", "tree-sitter.wasm")
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
    const bytes = await fs.readFile(grammarAssetPath(language));
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
  return filePath.replace(/\.(?:[cm]?jsx?|tsx?|mts|cts|py|go|rs|java|kt|kts|scala|sc|lua|zig|cs|php|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, "");
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

function goReceiverBinding(node: TreeNode | null | undefined): GoReceiverBinding {
  if (!node) {
    return {};
  }
  const names = uniqueBy(
    node
      .descendantsOfType(["identifier", "type_identifier"])
      .filter((item): item is TreeNode => item !== null)
      .map((item) => normalizeSymbolReference(item.text))
      .filter(Boolean),
    (item) => item
  );
  if (names.length === 0) {
    return {};
  }
  if (names.length === 1) {
    return { typeName: names[0] };
  }
  return {
    variableName: names[0],
    typeName: names.at(-1)
  };
}

function goCalledSymbolName(node: TreeNode | null | undefined, receiver: GoReceiverBinding): string | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === "selector_expression") {
    const targetName = normalizeSymbolReference(
      extractIdentifier(node.childForFieldName("operand") ?? node.childForFieldName("object") ?? node.namedChildren.at(0) ?? null) ?? ""
    );
    const fieldName = normalizeSymbolReference(
      extractIdentifier(node.childForFieldName("field") ?? findNamedChild(node, "field_identifier") ?? node.namedChildren.at(-1) ?? null) ??
        ""
    );
    if (!fieldName) {
      return undefined;
    }
    if (receiver.variableName && receiver.typeName && targetName === receiver.variableName) {
      return `${receiver.typeName}.${fieldName}`;
    }
    return fieldName;
  }

  return normalizeSymbolReference(extractIdentifier(node) ?? "");
}

function goCallNamesFromBody(bodyNode: TreeNode | null | undefined, receiver: GoReceiverBinding): string[] {
  if (!bodyNode) {
    return [];
  }
  return uniqueBy(
    bodyNode
      .descendantsOfType("call_expression")
      .filter((item): item is TreeNode => item !== null)
      .map((callNode) => goCalledSymbolName(callNode.childForFieldName("function") ?? callNode.namedChildren.at(0) ?? null, receiver))
      .filter((name): name is string => Boolean(name)),
    (name) => name
  );
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
  if (
    [
      "identifier",
      "simple_identifier",
      "field_identifier",
      "type_identifier",
      "name",
      "package_identifier",
      "constant",
      "simple_name",
      "function_name"
    ].includes(node.type)
  ) {
    return node.text.trim();
  }
  const preferred =
    node.childForFieldName("name") ??
    node.namedChildren.find(
      (child) =>
        child &&
        [
          "identifier",
          "simple_identifier",
          "field_identifier",
          "type_identifier",
          "name",
          "package_identifier",
          "constant",
          "simple_name",
          "function_name"
        ].includes(child.type)
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
  return value.replace(/^['"<]+|['">]+$/g, "").trim();
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

function treeSitterCompatibilityMessage(
  language: Exclude<CodeLanguage, "javascript" | "jsx" | "typescript" | "tsx">,
  error: unknown
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "MODULE_NOT_FOUND") {
    return `Tree-sitter runtime support for ${language} is unavailable. Reinstall @swarmvaultai/engine so the packaged parser runtime is present.`;
  }
  if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "ENOENT") {
    return `Missing tree-sitter grammar asset for ${language}. Reinstall @swarmvaultai/engine so the packaged grammar files are present.`;
  }
  return `Tree-sitter support for ${language} could not load: ${truncate(normalizeWhitespace(message), 220)}.`;
}

function treeSitterCompatibilityDiagnostic(
  language: Exclude<CodeLanguage, "javascript" | "jsx" | "typescript" | "tsx">,
  error: unknown
): CodeDiagnostic {
  return {
    code: 9010,
    category: "error",
    message: treeSitterCompatibilityMessage(language, error),
    line: 1,
    column: 1
  };
}

export function resetTreeSitterLanguageCacheForTests(): void {
  treeSitterModulePromise = undefined;
  treeSitterInitPromise = undefined;
  languageCache.clear();
  packageRootCache.clear();
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

function parseKotlinImport(text: string): CodeImport | undefined {
  const cleaned = text.trim().replace(/^import\s+/, "");
  if (!cleaned) {
    return undefined;
  }
  const aliasMatch = cleaned.match(/^(.+?)\s+as\s+([A-Za-z_]\w*)$/);
  const specifier = (aliasMatch ? aliasMatch[1] : cleaned).trim();
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    namespaceImport: aliasMatch?.[2],
    isExternal: !specifier.startsWith("."),
    reExport: false
  };
}

function parseScalaImport(text: string): CodeImport[] {
  const cleaned = text.trim().replace(/^import\s+/, "");
  if (!cleaned) {
    return [];
  }
  return cleaned
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => ({
      specifier: item.replace(/\s*=>\s*/g, " => "),
      importedSymbols: [],
      isExternal: !item.startsWith("."),
      reExport: false
    }));
}

function parseLuaRequire(node: TreeNode): CodeImport | undefined {
  const stringNode = node.descendantsOfType("string").find((item): item is TreeNode => item !== null);
  const identifiers = node
    .descendantsOfType("identifier")
    .filter((item): item is TreeNode => item !== null)
    .map((item) => item.text.trim());
  if (!stringNode || !identifiers.includes("require")) {
    return undefined;
  }
  const specifier = quotedPath(stringNode.text);
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    isExternal: !/^[A-Za-z_][A-Za-z0-9_]*(?:[./][A-Za-z_][A-Za-z0-9_]*)*$/.test(specifier),
    reExport: false
  };
}

function parseZigImport(node: TreeNode): CodeImport | undefined {
  if (node.type !== "variable_declaration") {
    return undefined;
  }
  const importCall = findNamedChild(node, "builtin_function");
  if (!importCall || nodeText(findNamedChild(importCall, "builtin_identifier") ?? importCall.namedChildren.at(0) ?? null) !== "@import") {
    return undefined;
  }
  const stringNode = importCall.descendantsOfType("string_content").find((item): item is TreeNode => item !== null);
  const specifier = stringNode?.text.trim();
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    isExternal: !specifier.endsWith(".zig") && !specifier.includes("/") && !specifier.startsWith("."),
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

function rubyStringContent(node: TreeNode | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  const contentNode =
    node.descendantsOfType(["string_content", "simple_symbol", "bare_string"]).find((item): item is TreeNode => item !== null) ?? null;
  return contentNode?.text.trim() || undefined;
}

function parsePowerShellImport(commandNode: TreeNode): CodeImport | undefined {
  const commandName = commandNode
    .descendantsOfType(["command_name", "command_name_expr"])
    .find((item): item is TreeNode => item !== null)
    ?.text.trim();
  const genericTokens = commandNode
    .descendantsOfType("generic_token")
    .filter((item): item is TreeNode => item !== null)
    .map((item) => item.text.trim());

  if (commandNode.namedChildren.some((child) => child?.type === "command_invokation_operator")) {
    const specifier = commandName?.trim();
    if (specifier) {
      return {
        specifier,
        importedSymbols: [],
        isExternal: false,
        reExport: false
      };
    }
  }

  if (!commandName) {
    return undefined;
  }

  const lowerName = commandName.toLowerCase();
  if (lowerName === "using" && genericTokens.length >= 2 && genericTokens[0]?.toLowerCase() === "module") {
    return {
      specifier: genericTokens[1],
      importedSymbols: [],
      isExternal: !genericTokens[1]?.startsWith("."),
      reExport: false
    };
  }

  if (lowerName === "import-module" && genericTokens[0]) {
    return {
      specifier: genericTokens[0],
      importedSymbols: [],
      isExternal: !genericTokens[0].startsWith("."),
      reExport: false
    };
  }

  return undefined;
}

function keywordVisible(text: string, hiddenKeywords: string[]): boolean {
  return !hiddenKeywords.some((keyword) => new RegExp(`\\b${keyword}\\b`).test(text));
}

function declarationVisible(node: TreeNode, hiddenKeywords: string[]): boolean {
  const modifierText = nodeText(findNamedChild(node, "modifiers") ?? node.childForFieldName("modifiers"));
  return modifierText ? keywordVisible(modifierText, hiddenKeywords) : true;
}

function kotlinClassKind(text: string): CodeSymbolKind {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("interface ")) {
    return "interface";
  }
  if (trimmed.startsWith("enum class ")) {
    return "enum";
  }
  return "class";
}

function scalaDefinitionKind(node: TreeNode): CodeSymbolKind | undefined {
  if (node.type === "trait_definition") {
    return "trait";
  }
  if (node.type === "class_definition") {
    return /\bcase\s+class\b/.test(node.text) ? "class" : "class";
  }
  if (node.type === "object_definition") {
    return "class";
  }
  if (node.type === "function_definition") {
    return "function";
  }
  return undefined;
}

function luaFunctionName(node: TreeNode | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "identifier") {
    return node.text.trim();
  }
  if (node.type === "variable") {
    const identifiers = node
      .descendantsOfType("identifier")
      .filter((item): item is TreeNode => item !== null)
      .map((item) => item.text.trim())
      .filter(Boolean);
    return identifiers.length > 0 ? identifiers.join(".") : undefined;
  }
  return extractIdentifier(node);
}

function zigDeclarationKind(node: TreeNode): CodeSymbolKind | undefined {
  if (findNamedChild(node, "struct_declaration")) {
    return "struct";
  }
  if (findNamedChild(node, "enum_declaration")) {
    return "enum";
  }
  return undefined;
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
      const receiver = child.type === "method_declaration" ? goReceiverBinding(child.childForFieldName("receiver")) : {};
      const receiverType = receiver.typeName ?? "";
      const bodyNode = child.childForFieldName("body");
      const symbolName = receiverType ? `${receiverType}.${name}` : name;
      const exported = exportedByCapitalization(name);
      draftSymbols.push({
        name: symbolName,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported,
        callNames: goCallNamesFromBody(bodyNode, receiver),
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(bodyNode)
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

function kotlinCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  let packageName: string | undefined;

  const pushBodyFunctions = (bodyNode: TreeNode | null | undefined, scopeName?: string) => {
    if (!bodyNode) {
      return;
    }
    for (const child of bodyNode.namedChildren) {
      if (!child || child.type !== "function_declaration") {
        continue;
      }
      const functionName = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "simple_identifier"));
      if (!functionName) {
        continue;
      }
      const exported = declarationVisible(child, ["private", "internal", "protected"]);
      const symbolName = scopeName ? `${scopeName}.${functionName}` : functionName;
      draftSymbols.push({
        name: symbolName,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body") ?? findNamedChild(child, "function_body"))
      });
      if (exported) {
        exportLabels.push(symbolName);
      }
    }
  };

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "package_header") {
      packageName = nodeText(findNamedChild(child, "identifier") ?? child.namedChildren.at(0) ?? null) || packageName;
      continue;
    }
    if (child.type === "import_list") {
      for (const importNode of child.descendantsOfType("import_header").filter((item): item is TreeNode => item !== null)) {
        const parsed = parseKotlinImport(importNode.text);
        if (parsed) {
          imports.push(parsed);
        }
      }
      continue;
    }
    if (child.type === "function_declaration") {
      pushBodyFunctions({
        ...child,
        namedChildren: [child]
      } as TreeNode);
      continue;
    }
    if (child.type !== "class_declaration" && child.type !== "object_declaration") {
      continue;
    }

    const name = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "type_identifier"));
    if (!name) {
      continue;
    }
    const kind = child.type === "object_declaration" ? "class" : kotlinClassKind(child.text);
    const delegationNames = uniqueBy(
      child.namedChildren
        .filter((item): item is TreeNode => item !== null && item.type === "delegation_specifier")
        .flatMap((item) => descendantTypeNames(item)),
      (item) => item
    );
    const exported = declarationVisible(child, ["private", "internal"]);
    const bodyNode = findNamedChild(child, "class_body") ?? child.childForFieldName("body");
    draftSymbols.push({
      name,
      kind,
      signature: singleLineSignature(child.text),
      exported,
      callNames: [],
      extendsNames: kind === "interface" ? delegationNames : delegationNames.slice(0, 1),
      implementsNames: kind === "class" ? delegationNames.slice(1) : [],
      bodyText: nodeText(bodyNode) || child.text
    });
    if (exported) {
      exportLabels.push(name);
    }
    pushBodyFunctions(bodyNode, name);
  }

  return finalizeCodeAnalysis(manifest, "kotlin", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: packageName
  });
}

function scalaCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  let packageName: string | undefined;

  const pushTemplateFunctions = (bodyNode: TreeNode | null | undefined, scopeName?: string) => {
    if (!bodyNode) {
      return;
    }
    for (const child of bodyNode.namedChildren) {
      if (!child || child.type !== "function_definition") {
        continue;
      }
      const functionName = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
      if (!functionName) {
        continue;
      }
      const exported = declarationVisible(child, ["private", "protected"]);
      const symbolName = scopeName ? `${scopeName}.${functionName}` : functionName;
      draftSymbols.push({
        name: symbolName,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      if (exported) {
        exportLabels.push(symbolName);
      }
    }
  };

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "package_clause") {
      packageName = nodeText(findNamedChild(child, "package_identifier") ?? child.namedChildren.at(0) ?? null) || packageName;
      continue;
    }
    if (child.type === "import_declaration") {
      imports.push(...parseScalaImport(child.text));
      continue;
    }
    if (child.type === "function_definition") {
      pushTemplateFunctions({
        ...child,
        namedChildren: [child]
      } as TreeNode);
      continue;
    }
    if (!["trait_definition", "class_definition", "object_definition"].includes(child.type)) {
      continue;
    }

    const name = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
    const kind = scalaDefinitionKind(child);
    if (!name || !kind) {
      continue;
    }
    const extendsClause = findNamedChild(child, "extends_clause") ?? child.childForFieldName("extends");
    const inheritance = uniqueBy(descendantTypeNames(extendsClause), (item) => item);
    const bodyNode = findNamedChild(child, "template_body") ?? child.childForFieldName("body");
    const exported = declarationVisible(child, ["private", "protected"]);
    draftSymbols.push({
      name,
      kind,
      signature: singleLineSignature(child.text),
      exported,
      callNames: [],
      extendsNames: kind === "trait" ? inheritance : inheritance.slice(0, 1),
      implementsNames: kind === "class" ? inheritance.slice(1) : [],
      bodyText: nodeText(bodyNode) || child.text
    });
    if (exported) {
      exportLabels.push(name);
    }
    pushTemplateFunctions(bodyNode, name);
  }

  return finalizeCodeAnalysis(manifest, "scala", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: packageName
  });
}

function luaCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }

    if (child.type === "local_variable_declaration" || child.type === "assignment_statement") {
      const parsed = parseLuaRequire(child);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    if (!["function_definition_statement", "local_function_definition_statement"].includes(child.type)) {
      continue;
    }

    const name = luaFunctionName(child.childForFieldName("name") ?? child.namedChildren.at(0) ?? null);
    if (!name) {
      continue;
    }

    draftSymbols.push({
      name,
      kind: "function",
      signature: singleLineSignature(child.text),
      exported: child.type !== "local_function_definition_statement",
      callNames: [],
      extendsNames: [],
      implementsNames: [],
      bodyText: nodeText(findNamedChild(child, "block") ?? child.childForFieldName("body")) || child.text
    });
    if (child.type !== "local_function_definition_statement") {
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "lua", imports, draftSymbols, exportLabels, diagnostics);
}

function zigCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  const pushStructMembers = (structNode: TreeNode | null | undefined, scopeName: string) => {
    if (!structNode) {
      return;
    }
    for (const child of structNode.namedChildren) {
      if (!child || child.type !== "function_declaration") {
        continue;
      }
      const functionName = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
      if (!functionName) {
        continue;
      }
      const exported = /\bpub\b/.test(child.text);
      const symbolName = `${scopeName}.${functionName}`;
      draftSymbols.push({
        name: symbolName,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(findNamedChild(child, "block") ?? child.childForFieldName("body")) || child.text
      });
      if (exported) {
        exportLabels.push(symbolName);
      }
    }
  };

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "variable_declaration") {
      const parsedImport = parseZigImport(child);
      if (parsedImport) {
        imports.push(parsedImport);
        continue;
      }

      const name = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
      const kind = zigDeclarationKind(child);
      if (!name || !kind) {
        continue;
      }
      const declarationNode = findNamedChild(child, "struct_declaration") ?? findNamedChild(child, "enum_declaration");
      const exported = /\bpub\b/.test(child.text);
      draftSymbols.push({
        name,
        kind,
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(declarationNode) || child.text
      });
      if (exported) {
        exportLabels.push(name);
      }
      if (kind === "struct") {
        pushStructMembers(declarationNode, name);
      }
      continue;
    }

    if (child.type !== "function_declaration") {
      continue;
    }

    const functionName = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
    if (!functionName) {
      continue;
    }
    const exported = /\bpub\b/.test(child.text);
    draftSymbols.push({
      name: functionName,
      kind: "function",
      signature: singleLineSignature(child.text),
      exported,
      callNames: [],
      extendsNames: [],
      implementsNames: [],
      bodyText: nodeText(findNamedChild(child, "block") ?? child.childForFieldName("body")) || child.text
    });
    if (exported) {
      exportLabels.push(functionName);
    }
  }

  return finalizeCodeAnalysis(manifest, "zig", imports, draftSymbols, exportLabels, diagnostics);
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

function rubyCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  let namespaceName: string | undefined;

  const visitStatements = (node: TreeNode | null | undefined, scopeName?: string, namespaceParts: string[] = []) => {
    if (!node) {
      return;
    }

    for (const child of node.namedChildren) {
      if (!child) {
        continue;
      }

      if (child.type === "call") {
        const callee = extractIdentifier(child.namedChildren.at(0) ?? null);
        if (callee === "require" || callee === "require_relative") {
          const specifier = rubyStringContent(child.childForFieldName("arguments") ?? child.namedChildren.at(1) ?? null);
          if (specifier) {
            imports.push({
              specifier,
              importedSymbols: [],
              isExternal: callee === "require" && !specifier.startsWith("."),
              reExport: false
            });
          }
        }
        continue;
      }

      if (child.type === "module") {
        const moduleName = extractIdentifier(child.childForFieldName("name") ?? child.namedChildren.at(0) ?? null);
        if (!moduleName) {
          continue;
        }
        const nextNamespace = [...namespaceParts, moduleName];
        namespaceName ??= nextNamespace.join("::");
        visitStatements(findNamedChild(child, "body_statement"), undefined, nextNamespace);
        continue;
      }

      if (child.type === "class") {
        const className = extractIdentifier(child.childForFieldName("name") ?? child.namedChildren.at(0) ?? null);
        if (!className) {
          continue;
        }
        const body = findNamedChild(child, "body_statement");
        const mixins = body
          ? body.namedChildren
              .filter((item): item is TreeNode => item !== null && item.type === "call")
              .filter((item) => extractIdentifier(item.namedChildren.at(0) ?? null) === "include")
              .flatMap((item) =>
                item
                  .descendantsOfType(["constant", "identifier"])
                  .filter((descendant): descendant is TreeNode => descendant !== null)
                  .slice(1)
                  .map((descendant) => normalizeSymbolReference(descendant.text))
                  .filter(Boolean)
              )
          : [];
        draftSymbols.push({
          name: scopeName ? `${scopeName}::${className}` : className,
          kind: "class",
          signature: singleLineSignature(child.text),
          exported: true,
          callNames: [],
          extendsNames: descendantTypeNames(child.childForFieldName("superclass")),
          implementsNames: uniqueBy(mixins, (item) => item),
          bodyText: body?.text
        });
        exportLabels.push(scopeName ? `${scopeName}::${className}` : className);
        visitStatements(body, scopeName ? `${scopeName}::${className}` : className, namespaceParts);
        continue;
      }

      if (child.type === "method") {
        const methodName = extractIdentifier(child.childForFieldName("name") ?? child.namedChildren.at(0) ?? null);
        if (!methodName) {
          continue;
        }
        const symbolName = scopeName ? `${scopeName}#${methodName}` : methodName;
        draftSymbols.push({
          name: symbolName,
          kind: "function",
          signature: singleLineSignature(child.text),
          exported: true,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: nodeText(findNamedChild(child, "body_statement") ?? child.childForFieldName("body"))
        });
        exportLabels.push(symbolName);
      }
    }
  };

  visitStatements(rootNode, undefined, []);
  return finalizeCodeAnalysis(manifest, "ruby", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: namespaceName
  });
}

function powershellCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  for (const child of rootNode
    .descendantsOfType(["command", "class_statement", "function_statement"])
    .filter((item): item is TreeNode => item !== null)) {
    if (child.type === "command") {
      const parsed = parsePowerShellImport(child);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    if (child.type === "class_statement") {
      const names = child.namedChildren
        .filter((item): item is TreeNode => item !== null && item.type === "simple_name")
        .map((item) => item.text.trim());
      const className = names[0];
      if (!className) {
        continue;
      }
      draftSymbols.push({
        name: className,
        kind: "class",
        signature: singleLineSignature(child.text),
        exported: true,
        callNames: [],
        extendsNames: names.slice(1, 2),
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body")) || child.text
      });
      exportLabels.push(className);

      for (const methodNode of child.descendantsOfType("class_method_definition").filter((item): item is TreeNode => item !== null)) {
        const methodName = methodNode
          .descendantsOfType("simple_name")
          .filter((item): item is TreeNode => item !== null)
          .map((item) => item.text.trim())[0];
        if (!methodName) {
          continue;
        }
        const symbolName = `${className}.${methodName}`;
        draftSymbols.push({
          name: symbolName,
          kind: "function",
          signature: singleLineSignature(methodNode.text),
          exported: true,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: nodeText(findNamedChild(methodNode, "script_block") ?? methodNode.childForFieldName("body")) || methodNode.text
        });
        exportLabels.push(symbolName);
      }
      continue;
    }

    if (child.type === "function_statement") {
      const functionName = extractIdentifier(findNamedChild(child, "function_name") ?? child.childForFieldName("name"));
      if (!functionName) {
        continue;
      }
      draftSymbols.push({
        name: functionName,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(findNamedChild(child, "script_block") ?? child.childForFieldName("body")) || child.text
      });
      exportLabels.push(functionName);
    }
  }

  return finalizeCodeAnalysis(manifest, "powershell", imports, draftSymbols, exportLabels, diagnostics);
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
  let tree: Tree | null = null;
  try {
    const module = await getTreeSitterModule();
    await ensureTreeSitterInit(module);
    const parser = new module.Parser();
    parser.setLanguage(await loadLanguage(language));
    tree = parser.parse(content);
  } catch (error) {
    return {
      code: finalizeCodeAnalysis(manifest, language, [], [], [], [treeSitterCompatibilityDiagnostic(language, error)]),
      rationales: []
    };
  }

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
      case "kotlin":
        return { code: kotlinCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "scala":
        return { code: scalaCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "lua":
        return { code: luaCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "zig":
        return { code: zigCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "csharp":
        return { code: csharpCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "php":
        return { code: phpCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "ruby":
        return { code: rubyCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "powershell":
        return { code: powershellCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "c":
      case "cpp":
        return { code: cFamilyCodeAnalysis(manifest, language, tree.rootNode, diagnostics), rationales };
      default:
        return {
          code: finalizeCodeAnalysis(
            manifest,
            language,
            [],
            [],
            [],
            [
              {
                code: 9011,
                category: "error",
                message: `No parser-backed analyzer is registered for ${language}.`,
                line: 1,
                column: 1
              }
            ]
          ),
          rationales
        };
    }
  } finally {
    tree.delete();
  }
}
