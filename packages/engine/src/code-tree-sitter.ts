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
const SWIFT_TREE_SITTER_OPT_IN_ENV = "SWARMVAULT_ENABLE_SWIFT_TREE_SITTER";
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
  bash: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-bash.wasm" },
  python: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-python.wasm" },
  go: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-go.wasm" },
  rust: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-rust.wasm" },
  java: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-java.wasm" },
  kotlin: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-kotlin.wasm" },
  scala: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-scala.wasm" },
  dart: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-dart.wasm" },
  lua: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-lua.wasm" },
  zig: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-zig.wasm" },
  csharp: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-c-sharp.wasm" },
  c: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-cpp.wasm" },
  cpp: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-cpp.wasm" },
  php: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-php.wasm" },
  ruby: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-ruby.wasm" },
  powershell: { packageName: TREE_SITTER_RUNTIME_PACKAGE, relativePath: "wasm/tree-sitter-powershell.wasm" },
  swift: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-swift.wasm" },
  elixir: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-elixir.wasm" },
  ocaml: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-ocaml.wasm" },
  objc: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-objc.wasm" },
  rescript: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-rescript.wasm" },
  solidity: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-solidity.wasm" },
  html: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-html.wasm" },
  css: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-css.wasm" },
  vue: { packageName: TREE_SITTER_EXTRA_GRAMMARS_PACKAGE, relativePath: "out/tree-sitter-vue.wasm" }
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
  return filePath.replace(
    /\.(?:[cm]?jsx?|tsx?|mts|cts|sh|bash|zsh|py|go|rs|java|kt|kts|scala|sc|dart|lua|zig|cs|php|c|cc|cpp|cxx|h|hh|hpp|hxx|swift|exs?|mli?|mm|resi?|sol|html?|css|vue)$/i,
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

// Tree-sitter grammars for C, C++, and C# parse preprocessor directives as ordinary
// tokens with no branch resolution. When `#if` / `#else` / `#endif` interrupts a
// single statement or expression the grammar sees two partial fragments and emits
// spurious syntax errors (e.g. a dangling `else` split across `#endif`, or two
// expression-bodied method bodies joined by `&&` across an `#if`/`#else` pair).
//
// This helper walks the input line by line, always takes the first `#if` branch, and
// blanks out the conditional directive lines themselves plus every line inside
// non-taken branches. Other directives (`#include`, `#define`, `#pragma`, ...) pass
// through untouched because the grammars parse them cleanly and the downstream
// walkers (`parseCppInclude` and friends) rely on their AST nodes. "Blank" means an
// empty string with the trailing newline retained so downstream diagnostics keep
// their original line numbers.
function neutralizePreprocessorDirectives(content: string): string {
  const lines = content.split("\n");
  // Each stack entry records whether the current branch at this depth is taken.
  const active: boolean[] = [];
  const isActive = () => active.every(Boolean);
  const directiveHead = (line: string): string | undefined => {
    const trimmed = line.trimStart();
    if (trimmed[0] !== "#") {
      return undefined;
    }
    const rest = trimmed.slice(1).trimStart();
    const match = rest.match(/^([A-Za-z]+)/);
    return match?.[1]?.toLowerCase();
  };
  const out: string[] = [];
  for (const line of lines) {
    const head = directiveHead(line);
    if (head === "if" || head === "ifdef" || head === "ifndef") {
      active.push(isActive());
      out.push("");
      continue;
    }
    if (head === "elif") {
      if (active.length > 0) {
        active[active.length - 1] = false;
      }
      out.push("");
      continue;
    }
    if (head === "else") {
      if (active.length > 0) {
        active[active.length - 1] = false;
      }
      out.push("");
      continue;
    }
    if (head === "endif") {
      if (active.length > 0) {
        active.pop();
      }
      out.push("");
      continue;
    }
    if (!isActive()) {
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Detect shell scripts that use zsh-only syntax. Tree-sitter-bash parses POSIX bash
// only, so feeding it zsh scripts produces noisy grammar errors. Rather than ship a
// separate zsh grammar (tree-sitter-wasms does not include one) we detect the dialect
// and suppress tree-sitter diagnostics for the affected file — the descendant-based
// symbol and import walkers still extract functions and `source` edges, same as the
// Lua suppression path.
function detectShellDialect(content: string): "zsh" | "bash" {
  const prefix = content.slice(0, 4096);
  if (/^#!\s*(?:\/usr\/bin\/env\s+)?zsh\b/m.test(prefix)) {
    return "zsh";
  }
  if (/^\s*#compdef\b/m.test(prefix)) {
    return "zsh";
  }
  if (/\$\{\([fFsq@%]/.test(prefix)) {
    return "zsh";
  }
  if (/\b(?:setopt|unsetopt|zmodload|compinit|autoload\s+-Uz)\b/.test(prefix)) {
    return "zsh";
  }
  return "bash";
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

function swiftTreeSitterEnabled(): boolean {
  return process.env[SWIFT_TREE_SITTER_OPT_IN_ENV] === "1";
}

function swiftTreeSitterDisabledDiagnostic(): CodeDiagnostic {
  return {
    code: 9012,
    category: "warning",
    message:
      `Swift parser-backed analysis is disabled by default because the packaged tree-sitter grammar can trigger Node/V8 out-of-memory crashes during WASM compilation. ` +
      `Set ${SWIFT_TREE_SITTER_OPT_IN_ENV}=1 to opt in anyway.`,
    line: 1,
    column: 1
  };
}

// Join the `identifier` children of a `dotted_name` tree-sitter node with `.`.
function flattenPythonDottedName(node: TreeNode | null | undefined): string {
  if (!node) {
    return "";
  }
  return node.namedChildren
    .filter((child): child is TreeNode => child?.type === "identifier")
    .map((child) => child.text.trim())
    .filter(Boolean)
    .join(".");
}

// Flatten a `relative_import` node into its dotted specifier (`..pkg.mod`).
function flattenPythonRelativeImport(node: TreeNode | null | undefined): string {
  if (!node) {
    return "";
  }
  const prefixNode = node.namedChildren.find((child): child is TreeNode => child?.type === "import_prefix") ?? null;
  const prefix = prefixNode ? prefixNode.text.trim() : "";
  const moduleNode = node.namedChildren.find((child): child is TreeNode => child?.type === "dotted_name") ?? null;
  const module = flattenPythonDottedName(moduleNode);
  return prefix + module;
}

function parsePythonImportStatement(node: TreeNode): CodeImport[] {
  const imports: CodeImport[] = [];
  for (const child of node.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "dotted_name") {
      const specifier = flattenPythonDottedName(child);
      if (!specifier) {
        continue;
      }
      imports.push({
        specifier,
        importedSymbols: [],
        isExternal: !specifier.startsWith("."),
        reExport: false
      });
    } else if (child.type === "aliased_import") {
      const moduleNode = child.namedChildren.find((inner): inner is TreeNode => inner?.type === "dotted_name") ?? null;
      const aliasNode = child.namedChildren.find((inner): inner is TreeNode => inner?.type === "identifier") ?? null;
      const specifier = flattenPythonDottedName(moduleNode);
      if (!specifier) {
        continue;
      }
      imports.push({
        specifier,
        importedSymbols: [],
        namespaceImport: aliasNode?.text.trim(),
        isExternal: !specifier.startsWith("."),
        reExport: false
      });
    }
  }
  return imports;
}

function parsePythonFromImportStatement(node: TreeNode): CodeImport[] {
  const children = node.namedChildren.filter((child): child is TreeNode => child !== null);
  if (children.length === 0) {
    return [];
  }
  const [moduleNode, ...rest] = children;
  if (!moduleNode) {
    return [];
  }
  let specifier: string;
  if (moduleNode.type === "relative_import") {
    specifier = flattenPythonRelativeImport(moduleNode);
  } else if (moduleNode.type === "dotted_name") {
    specifier = flattenPythonDottedName(moduleNode);
  } else {
    return [];
  }
  if (!specifier) {
    return [];
  }
  const symbols: string[] = [];
  let hasWildcard = false;
  for (const entry of rest) {
    if (entry.type === "wildcard_import") {
      hasWildcard = true;
      continue;
    }
    if (entry.type === "dotted_name") {
      const name = flattenPythonDottedName(entry);
      if (name) {
        symbols.push(name);
      }
      continue;
    }
    if (entry.type === "aliased_import") {
      const moduleChild = entry.namedChildren.find((inner): inner is TreeNode => inner?.type === "dotted_name") ?? null;
      const aliasChild = entry.namedChildren.find((inner): inner is TreeNode => inner?.type === "identifier") ?? null;
      const baseName = flattenPythonDottedName(moduleChild);
      const aliasName = aliasChild?.text.trim();
      if (baseName) {
        symbols.push(aliasName ? `${baseName} as ${aliasName}` : baseName);
      }
    }
  }
  if (hasWildcard) {
    symbols.push("*");
  }
  return [
    {
      specifier,
      importedSymbols: symbols,
      isExternal: !specifier.startsWith("."),
      reExport: false
    }
  ];
}

function parseGoImport(spec: TreeNode): CodeImport | undefined {
  let alias: string | undefined;
  let dotImport = false;
  let blankImport = false;
  let specifier: string | undefined;
  for (const child of spec.namedChildren) {
    if (!child) {
      continue;
    }
    switch (child.type) {
      case "package_identifier":
        alias = child.text.trim();
        break;
      case "dot":
        dotImport = true;
        break;
      case "blank_identifier":
        blankImport = true;
        break;
      case "interpreted_string_literal":
      case "raw_string_literal": {
        const content =
          child.namedChildren.find(
            (inner): inner is TreeNode =>
              inner?.type === "interpreted_string_literal_content" || inner?.type === "raw_string_literal_content"
          ) ?? null;
        specifier = content ? content.text : child.text.replace(/^[`"]|[`"]$/g, "");
        break;
      }
      default:
        break;
    }
  }
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    namespaceImport: !dotImport && !blankImport ? alias : undefined,
    isExternal: !specifier.startsWith("."),
    reExport: false
  };
}

type RustUseLeaf = {
  segments: string[];
  symbol: string | null;
  wildcard: boolean;
  alias?: string;
};

// Flatten a Rust path node (scoped_identifier / identifier / crate / self / super)
// into its dotted segments. The tree-sitter-rust grammar uses named node types
// `crate`, `self`, and `super` for the root keyword, plus `identifier` for the
// intermediate segments.
function flattenRustPath(node: TreeNode | null | undefined): string[] {
  if (!node) {
    return [];
  }
  if (node.type === "crate" || node.type === "self" || node.type === "super") {
    return [node.type];
  }
  if (node.type === "identifier") {
    return [node.text.trim()].filter(Boolean);
  }
  if (node.type === "scoped_identifier") {
    const segments: string[] = [];
    for (const child of node.namedChildren) {
      if (!child) {
        continue;
      }
      segments.push(...flattenRustPath(child));
    }
    return segments;
  }
  // Fallback: concatenate identifier-like descendants.
  return node.namedChildren.filter((child): child is TreeNode => child !== null).flatMap((child) => flattenRustPath(child));
}

function collectRustUseLeaves(node: TreeNode | null | undefined, prefix: string[], leaves: RustUseLeaf[]): void {
  if (!node) {
    return;
  }
  switch (node.type) {
    case "scoped_identifier": {
      const segments = flattenRustPath(node);
      if (segments.length === 0) {
        return;
      }
      leaves.push({
        segments: [...prefix, ...segments],
        symbol: segments[segments.length - 1] ?? null,
        wildcard: false
      });
      return;
    }
    case "identifier":
    case "crate":
    case "self":
    case "super": {
      // Root-word shortcuts like `use self;` or inside a use_list: `{self, Bar}`.
      const combined = [...prefix];
      if (node.type === "self" && prefix.length > 0) {
        // `self` inside a brace group re-references the prefix itself, not a new segment.
        leaves.push({ segments: combined, symbol: null, wildcard: false });
        return;
      }
      combined.push(node.type === "identifier" ? node.text.trim() : node.type);
      leaves.push({
        segments: combined,
        symbol: combined[combined.length - 1] ?? null,
        wildcard: false
      });
      return;
    }
    case "scoped_use_list": {
      const pathNode = node.namedChildren[0] ?? null;
      const listNode = node.namedChildren[1] ?? null;
      const nextPrefix = [...prefix, ...flattenRustPath(pathNode)];
      collectRustUseLeaves(listNode, nextPrefix, leaves);
      return;
    }
    case "use_list": {
      for (const child of node.namedChildren) {
        collectRustUseLeaves(child, prefix, leaves);
      }
      return;
    }
    case "use_wildcard": {
      const pathNode = node.namedChildren[0] ?? null;
      const pathSegments = pathNode ? flattenRustPath(pathNode) : [];
      leaves.push({
        segments: [...prefix, ...pathSegments],
        symbol: null,
        wildcard: true
      });
      return;
    }
    case "use_as_clause": {
      const pathNode = node.childForFieldName("path") ?? node.namedChildren[0] ?? null;
      const aliasNode = node.childForFieldName("alias") ?? node.namedChildren[1] ?? null;
      const before = leaves.length;
      collectRustUseLeaves(pathNode, prefix, leaves);
      const alias = aliasNode?.text.trim();
      if (alias) {
        for (let index = before; index < leaves.length; index += 1) {
          const leaf = leaves[index];
          if (leaf) {
            leaf.alias = alias;
          }
        }
      }
      return;
    }
    default: {
      // Unknown variant — walk into children as a best-effort fallback.
      for (const child of node.namedChildren) {
        collectRustUseLeaves(child, prefix, leaves);
      }
    }
  }
}

function isRustPubUse(useNode: TreeNode): boolean {
  // `pub use foo;` exposes a `visibility_modifier` as the first non-use child inside
  // the `use_declaration`. Check that bounded token position rather than regexing the
  // declaration text.
  for (const child of useNode.children) {
    if (!child) {
      continue;
    }
    if (child.type === "visibility_modifier") {
      return true;
    }
    if (child.type === "use") {
      return false;
    }
  }
  return false;
}

function parseRustUseDeclaration(useNode: TreeNode): CodeImport[] {
  const inner = useNode.namedChildren.find((child): child is TreeNode => child !== null) ?? null;
  if (!inner) {
    return [];
  }
  const leaves: RustUseLeaf[] = [];
  collectRustUseLeaves(inner, [], leaves);
  if (leaves.length === 0) {
    return [];
  }
  const reExport = isRustPubUse(useNode);
  return leaves.map((leaf) => {
    const specifier = leaf.segments.join("::");
    const importedSymbols = leaf.wildcard
      ? ["*"]
      : leaf.alias && leaf.symbol
        ? [`${leaf.symbol} as ${leaf.alias}`]
        : leaf.symbol
          ? [leaf.symbol]
          : [];
    return {
      specifier,
      importedSymbols,
      isExternal: !/^(?:crate|self|super)(?:$|::)/.test(specifier),
      reExport
    } satisfies CodeImport;
  });
}

// Flatten a Java `scoped_identifier` / Kotlin-like nested identifier node into its
// dotted textual form by concatenating the nested `scoped_identifier` path head with
// the trailing `identifier`.
function flattenJavaScopedIdentifier(node: TreeNode | null | undefined): string {
  if (!node) {
    return "";
  }
  if (node.type === "identifier") {
    return node.text.trim();
  }
  if (node.type === "scoped_identifier") {
    const head = node.namedChildren[0] ?? null;
    const tail = node.namedChildren[node.namedChildren.length - 1] ?? null;
    const headText = flattenJavaScopedIdentifier(head);
    const tailText = tail && tail !== head && tail.type === "identifier" ? tail.text.trim() : "";
    return headText && tailText ? `${headText}.${tailText}` : headText || tailText;
  }
  return node.text.trim();
}

function parseJavaImport(node: TreeNode): CodeImport {
  const pathNode = node.namedChildren.find((child): child is TreeNode => child?.type === "scoped_identifier") ?? null;
  const hasAsterisk = node.namedChildren.some((child) => child?.type === "asterisk");
  const pathText = flattenJavaScopedIdentifier(pathNode);
  const specifier = hasAsterisk ? `${pathText}.*` : pathText;
  const symbolName = hasAsterisk ? "" : (pathText.split(".").pop() ?? "").trim();
  return {
    specifier,
    importedSymbols: symbolName ? [symbolName] : [],
    isExternal: true,
    reExport: false
  };
}

// Flatten a Kotlin identifier node (which itself contains nested `simple_identifier`
// children) into a dotted path.
function flattenKotlinIdentifier(node: TreeNode | null | undefined): string {
  if (!node) {
    return "";
  }
  if (node.type === "simple_identifier") {
    return node.text.trim();
  }
  return node.namedChildren
    .filter((child): child is TreeNode => child?.type === "simple_identifier")
    .map((child) => child.text.trim())
    .filter(Boolean)
    .join(".");
}

function parseKotlinImport(header: TreeNode): CodeImport | undefined {
  const identifierNode = header.namedChildren.find((child): child is TreeNode => child?.type === "identifier") ?? null;
  const specifier = flattenKotlinIdentifier(identifierNode);
  if (!specifier) {
    return undefined;
  }
  const hasWildcard = header.descendantsOfType("wildcard_import").some((child) => child !== null);
  const aliasNode = header.namedChildren.find((child): child is TreeNode => child?.type === "import_alias") ?? null;
  const aliasName = aliasNode
    ? flattenKotlinIdentifier(aliasNode.namedChildren.find((child): child is TreeNode => child?.type === "type_identifier") ?? null) ||
      aliasNode.text.replace(/^as\s+/, "").trim()
    : undefined;
  return {
    specifier: hasWildcard ? `${specifier}.*` : specifier,
    importedSymbols: hasWildcard ? ["*"] : [],
    namespaceImport: aliasName || undefined,
    isExternal: true,
    reExport: false
  };
}

// Flatten a Scala `stable_identifier` node into its dotted path. Nested
// `stable_identifier` children represent the path head; the trailing `identifier`
// represents the last segment.
function flattenScalaStableIdentifier(node: TreeNode | null | undefined): string {
  if (!node) {
    return "";
  }
  if (node.type === "identifier") {
    return node.text.trim();
  }
  if (node.type === "stable_identifier") {
    return node.namedChildren
      .filter((child): child is TreeNode => child !== null)
      .map((child) => flattenScalaStableIdentifier(child))
      .filter(Boolean)
      .join(".");
  }
  return node.text.trim();
}

function parseScalaImport(node: TreeNode): CodeImport[] {
  const pathNode =
    node.namedChildren.find((child): child is TreeNode => child?.type === "stable_identifier") ??
    node.namedChildren.find((child): child is TreeNode => child?.type === "identifier") ??
    null;
  const basePath = flattenScalaStableIdentifier(pathNode);
  if (!basePath) {
    return [];
  }

  const selectorsNode = node.namedChildren.find((child): child is TreeNode => child?.type === "import_selectors") ?? null;
  const wildcardNode = node.namedChildren.find((child): child is TreeNode => child?.type === "wildcard") ?? null;

  if (selectorsNode) {
    const results: CodeImport[] = [];
    for (const selector of selectorsNode.namedChildren) {
      if (!selector) {
        continue;
      }
      if (selector.type === "identifier") {
        const symbol = selector.text.trim();
        if (symbol) {
          results.push({
            specifier: basePath,
            importedSymbols: [symbol],
            isExternal: !basePath.startsWith("."),
            reExport: false
          });
        }
        continue;
      }
      if (selector.type === "renamed_identifier") {
        const idChildren = selector.namedChildren.filter((child): child is TreeNode => child?.type === "identifier");
        const [original, alias] = [idChildren[0]?.text.trim(), idChildren[1]?.text.trim()];
        if (original) {
          results.push({
            specifier: basePath,
            importedSymbols: [alias ? `${original} as ${alias}` : original],
            isExternal: !basePath.startsWith("."),
            reExport: false
          });
        }
        continue;
      }
      if (selector.type === "wildcard") {
        results.push({
          specifier: basePath,
          importedSymbols: ["*"],
          isExternal: !basePath.startsWith("."),
          reExport: false
        });
      }
    }
    return results;
  }

  if (wildcardNode) {
    return [
      {
        specifier: basePath,
        importedSymbols: ["*"],
        isExternal: !basePath.startsWith("."),
        reExport: false
      }
    ];
  }

  // Plain `import scala.collection.mutable` — last segment is the symbol.
  const segments = basePath.split(".");
  const symbol = segments.pop() ?? basePath;
  const parent = segments.join(".");
  return [
    {
      specifier: parent || basePath,
      importedSymbols: [symbol],
      isExternal: !basePath.startsWith("."),
      reExport: false
    }
  ];
}

function bashCommandName(commandNode: TreeNode | null | undefined): string | undefined {
  if (!commandNode) {
    return undefined;
  }
  const nameNode =
    commandNode.childForFieldName("name") ?? findNamedChild(commandNode, "command_name") ?? commandNode.namedChildren.at(0) ?? null;
  if (!nameNode) {
    return undefined;
  }
  return nodeText(findNamedChild(nameNode, "word") ?? nameNode.namedChildren.at(0) ?? nameNode).trim() || undefined;
}

function bashSpecifierLooksLocal(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("/") || /\.(?:sh|bash|zsh)$/i.test(specifier);
}

function parseBashImport(commandNode: TreeNode): CodeImport | undefined {
  const commandName = bashCommandName(commandNode);
  if (commandName !== "source" && commandName !== ".") {
    return undefined;
  }
  const argumentNode =
    commandNode.childForFieldName("argument") ??
    commandNode.namedChildren.find((child) => child && child !== (commandNode.childForFieldName("name") ?? null)) ??
    null;
  const specifier = quotedPath(nodeText(argumentNode));
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    isExternal: !bashSpecifierLooksLocal(specifier),
    reExport: false
  };
}

function parseDartUri(node: TreeNode | null | undefined): string | undefined {
  const stringNode = node?.descendantsOfType("string_literal").find((item): item is TreeNode => item !== null) ?? null;
  return stringNode ? quotedPath(stringNode.text) : undefined;
}

function dartSpecifierLooksLocal(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    (!specifier.startsWith("package:") && !specifier.includes(":") && specifier.endsWith(".dart"))
  );
}

function parseDartDirective(node: TreeNode): CodeImport | undefined {
  if (node.type === "import_or_export") {
    const importNode = findNamedChild(node, "library_import");
    if (importNode) {
      const specifier = parseDartUri(
        findNamedChild(importNode, "configurable_uri") ??
          findNamedChild(findNamedChild(importNode, "import_specification"), "configurable_uri") ??
          importNode
      );
      if (!specifier) {
        return undefined;
      }
      return {
        specifier,
        importedSymbols: [],
        isExternal: !dartSpecifierLooksLocal(specifier) && !specifier.startsWith("package:"),
        reExport: false
      };
    }

    const exportNode = findNamedChild(node, "library_export");
    if (exportNode) {
      const specifier = parseDartUri(findNamedChild(exportNode, "configurable_uri") ?? exportNode);
      if (!specifier) {
        return undefined;
      }
      return {
        specifier,
        importedSymbols: [],
        isExternal: !dartSpecifierLooksLocal(specifier) && !specifier.startsWith("package:"),
        reExport: true
      };
    }
    return undefined;
  }

  if (node.type !== "part_directive") {
    return undefined;
  }
  const specifier = parseDartUri(findNamedChild(node, "uri") ?? node);
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    isExternal: false,
    reExport: false
  };
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

// Flatten a C# `qualified_name` / `identifier` node into its dotted form.
function flattenCSharpQualifiedName(node: TreeNode | null | undefined): string {
  if (!node) {
    return "";
  }
  if (node.type === "identifier") {
    return node.text.trim();
  }
  if (node.type === "qualified_name") {
    const [head, tail] = [node.namedChildren[0] ?? null, node.namedChildren[1] ?? null];
    const headText = flattenCSharpQualifiedName(head);
    const tailText = tail?.type === "identifier" ? tail.text.trim() : flattenCSharpQualifiedName(tail);
    return headText && tailText ? `${headText}.${tailText}` : headText || tailText;
  }
  return node.text.trim();
}

function parseCSharpUsing(node: TreeNode): CodeImport | undefined {
  const namedChildren = node.namedChildren.filter((child): child is TreeNode => child !== null);
  if (namedChildren.length === 0) {
    return undefined;
  }
  // `using Alias = Qualified.Name` has an `identifier` alias followed by the path.
  let aliasName: string | undefined;
  let pathNode: TreeNode | null = null;
  if (namedChildren.length >= 2 && namedChildren[0]?.type === "identifier" && namedChildren[1]) {
    aliasName = namedChildren[0].text.trim();
    pathNode = namedChildren[1];
  } else {
    pathNode = namedChildren[0] ?? null;
  }
  const specifier = flattenCSharpQualifiedName(pathNode);
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    namespaceImport: aliasName,
    isExternal: !specifier.startsWith("."),
    reExport: false
  };
}

// Flatten a PHP `qualified_name` / `namespace_name` / `name` node into a dotted path
// (PHP uses `\` as separator, but we store specifiers as dotted for consistency with
// how the CodeIndex stores package aliases).
function flattenPhpQualifiedName(node: TreeNode | null | undefined): string {
  if (!node) {
    return "";
  }
  if (node.type === "name") {
    return node.text.trim();
  }
  if (node.type === "namespace_name") {
    return node.namedChildren
      .filter((child): child is TreeNode => child?.type === "name")
      .map((child) => child.text.trim())
      .filter(Boolean)
      .join("\\");
  }
  if (node.type === "qualified_name") {
    const parts: string[] = [];
    for (const child of node.namedChildren) {
      if (!child) {
        continue;
      }
      if (child.type === "namespace_name") {
        parts.push(flattenPhpQualifiedName(child));
      } else if (child.type === "name") {
        parts.push(child.text.trim());
      }
    }
    return parts.filter(Boolean).join("\\");
  }
  return node.text.trim();
}

function parsePhpUseClause(clause: TreeNode, prefix: string): CodeImport | undefined {
  const names = clause.namedChildren.filter((child): child is TreeNode => child?.type === "name");
  const qualified = clause.namedChildren.find((child): child is TreeNode => child?.type === "qualified_name") ?? null;
  let specifier: string;
  let aliasName: string | undefined;
  if (qualified) {
    specifier = flattenPhpQualifiedName(qualified);
    if (names.length >= 1 && names[0]) {
      aliasName = names[0].text.trim();
    }
  } else if (names.length >= 1 && names[0]) {
    specifier = names[0].text.trim();
    if (names.length >= 2 && names[1]) {
      aliasName = names[1].text.trim();
    }
  } else {
    return undefined;
  }
  if (prefix && specifier) {
    specifier = `${prefix}\\${specifier}`;
  }
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    namespaceImport: aliasName,
    isExternal: true,
    reExport: false
  };
}

function parsePhpUse(node: TreeNode): CodeImport[] {
  const results: CodeImport[] = [];
  // Grouped form: `use Foo\{Bar, Baz};` — leading `namespace_name` plus a
  // `namespace_use_group` containing multiple clauses.
  const groupNode = node.namedChildren.find((child): child is TreeNode => child?.type === "namespace_use_group") ?? null;
  if (groupNode) {
    const prefixNode = node.namedChildren.find((child): child is TreeNode => child?.type === "namespace_name") ?? null;
    const prefix = flattenPhpQualifiedName(prefixNode);
    for (const clause of groupNode.namedChildren) {
      if (!clause || clause.type !== "namespace_use_clause") {
        continue;
      }
      const parsed = parsePhpUseClause(clause, prefix);
      if (parsed) {
        results.push(parsed);
      }
    }
    return results;
  }
  // Flat form: `use Foo\Bar;` — one or more `namespace_use_clause` children.
  for (const child of node.namedChildren) {
    if (!child || child.type !== "namespace_use_clause") {
      continue;
    }
    const parsed = parsePhpUseClause(child, "");
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

function parseCppInclude(node: TreeNode): CodeImport | undefined {
  for (const child of node.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "system_lib_string") {
      const specifier = child.text.replace(/^</, "").replace(/>$/, "").trim();
      if (!specifier) {
        return undefined;
      }
      return {
        specifier,
        importedSymbols: [],
        isExternal: true,
        reExport: false
      };
    }
    if (child.type === "string_literal") {
      const contentNode = child.namedChildren.find((inner): inner is TreeNode => inner?.type === "string_content") ?? null;
      const specifier = (contentNode?.text ?? child.text.replace(/^"|"$/g, "")).trim();
      if (!specifier) {
        return undefined;
      }
      return {
        specifier,
        importedSymbols: [],
        isExternal: false,
        reExport: false
      };
    }
  }
  return undefined;
}

function rubyStringContent(node: TreeNode | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  const contentNode =
    node.descendantsOfType(["string_content", "simple_symbol", "bare_string"]).find((item): item is TreeNode => item !== null) ?? null;
  return contentNode?.text.trim() || undefined;
}

function normalizePowerShellDotSourceSpecifier(raw: string): string {
  const unquoted = raw.replace(/^['"]+|['"]+$/g, "").trim();
  // `$PSScriptRoot` is the directory containing the currently-executing script in
  // PowerShell, so it is equivalent to a sibling path relative to the current file.
  // Normalize both `$PSScriptRoot/Foo.ps1` and the rarer `$PSScriptRoot\Foo.ps1` to
  // `./Foo.ps1` so the downstream local-path resolver can find them.
  const withoutScriptRoot = unquoted.replace(/^\$PSScriptRoot(?:[\\/]+|$)/i, "./");
  // Normalize Windows-style backslashes to forward slashes so POSIX path helpers can
  // reason about sibling imports.
  return withoutScriptRoot.replace(/\\/g, "/");
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
    const raw = commandName?.trim();
    if (raw) {
      return {
        specifier: normalizePowerShellDotSourceSpecifier(raw),
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

function bashCallNamesFromBody(bodyNode: TreeNode | null | undefined, selfName?: string): string[] {
  if (!bodyNode) {
    return [];
  }
  return uniqueBy(
    bodyNode
      .descendantsOfType("command")
      .filter((item): item is TreeNode => item !== null)
      .map((item) => bashCommandName(item))
      .filter((name): name is string => Boolean(name))
      .filter((name) => name !== "source" && name !== "." && name !== selfName),
    (name) => name
  );
}

function dartCallableName(node: TreeNode | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (node.type === "function_signature") {
    return extractIdentifier(node.childForFieldName("name") ?? findNamedChild(node, "identifier"));
  }
  if (node.type === "constructor_signature") {
    return extractIdentifier(node.childForFieldName("name") ?? findNamedChild(node, "identifier"));
  }
  return extractIdentifier(
    node.childForFieldName("name") ?? findNamedChild(node, "function_signature") ?? findNamedChild(node, "identifier")
  );
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

function bashCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[], rawContent?: string): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  // Use descendantsOfType rather than direct children so scripts that trip the
  // tree-sitter-bash grammar (e.g. zsh dialect constructs wrapped in ERROR nodes)
  // still surface their commands and function definitions.
  const commandNodes = rootNode.descendantsOfType("command").filter((node): node is TreeNode => node !== null);
  for (const command of commandNodes) {
    const parsed = parseBashImport(command);
    if (parsed) {
      imports.push(parsed);
    }
  }
  const functionNodes = rootNode.descendantsOfType("function_definition").filter((node): node is TreeNode => node !== null);
  const functionByName = new Map<string, TreeNode>();
  for (const child of functionNodes) {
    const name = nodeText(child.childForFieldName("name") ?? child.namedChildren.at(0) ?? null).trim();
    if (!name) {
      continue;
    }
    draftSymbols.push({
      name,
      kind: "function",
      signature: singleLineSignature(child.text),
      exported: true,
      callNames: [],
      extendsNames: [],
      implementsNames: [],
      bodyText: nodeText(child.childForFieldName("body") ?? findNamedChild(child, "compound_statement"))
    });
    exportLabels.push(name);
    if (!functionByName.has(name)) {
      functionByName.set(name, child);
    }
  }

  for (let index = 0; index < draftSymbols.length; index += 1) {
    const symbol = draftSymbols[index]!;
    const functionNode = functionByName.get(symbol.name);
    symbol.callNames = bashCallNamesFromBody(
      functionNode?.childForFieldName("body") ?? findNamedChild(functionNode, "compound_statement"),
      symbol.name
    );
  }

  // Fallback: if the tree-sitter parse recovered no functions at all — typically
  // when a zsh-only construct earlier in the file wrapped everything in an ERROR
  // node — scan the raw content for POSIX function definitions. This is the
  // escape hatch we reach when there is no parser available for the dialect:
  // extracting function names via a bounded line-anchored match preserves the
  // function edges in the graph. It mirrors how `interpreterFromShebang` already
  // uses a bounded text check for dialect detection.
  if (draftSymbols.length === 0 && rawContent) {
    const seen = new Set<string>();
    for (const line of rawContent.split("\n")) {
      const trimmed = line.trimStart();
      // `function name` or `function name()` style
      let match = trimmed.match(/^function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?/);
      if (!match) {
        // `name()` style
        match = trimmed.match(/^([A-Za-z_][\w-]*)\s*\(\)/);
      }
      const name = match?.[1];
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      draftSymbols.push({
        name,
        kind: "function",
        signature: singleLineSignature(trimmed),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: ""
      });
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "bash", imports, draftSymbols, exportLabels, diagnostics);
}

function dartCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  let libraryName: string | undefined;

  const pushScopedFunctions = (bodyNode: TreeNode | null | undefined, scopeName: string) => {
    if (!bodyNode) {
      return;
    }
    const children = bodyNode.namedChildren.filter((item): item is TreeNode => item !== null);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child) {
        continue;
      }

      if (child.type === "method_signature") {
        const signatureNode = findNamedChild(child, "function_signature") ?? child;
        const methodName = dartCallableName(signatureNode);
        if (!methodName) {
          continue;
        }
        const bodyNode = children[index + 1]?.type === "function_body" ? children[index + 1] : null;
        const symbolName = `${scopeName}.${methodName}`;
        const exported = !scopeName.startsWith("_") && !methodName.startsWith("_");
        draftSymbols.push({
          name: symbolName,
          kind: "function",
          signature: singleLineSignature(`${child.text} ${nodeText(bodyNode)}`),
          exported,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: nodeText(bodyNode)
        });
        if (exported) {
          exportLabels.push(symbolName);
        }
        continue;
      }

      if (child.type !== "declaration") {
        continue;
      }
      const constructorNode = findNamedChild(child, "constructor_signature");
      const constructorName = dartCallableName(constructorNode);
      if (!constructorName) {
        continue;
      }
      const symbolName = `${scopeName}.${constructorName}`;
      const exported = !scopeName.startsWith("_") && !constructorName.startsWith("_");
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

  const topLevelChildren = rootNode.namedChildren.filter((item): item is TreeNode => item !== null);
  for (let index = 0; index < topLevelChildren.length; index += 1) {
    const child = topLevelChildren[index];
    if (!child) {
      continue;
    }
    if (child.type === "library_name") {
      libraryName = nodeText(findNamedChild(child, "dotted_identifier_list") ?? child.namedChildren.at(-1) ?? null) || libraryName;
      continue;
    }
    if (child.type === "import_or_export" || child.type === "part_directive") {
      const parsed = parseDartDirective(child);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }
    if (child.type === "function_signature") {
      const functionName = dartCallableName(child);
      if (!functionName) {
        continue;
      }
      const bodyNode = topLevelChildren[index + 1]?.type === "function_body" ? topLevelChildren[index + 1] : null;
      const exported = !functionName.startsWith("_");
      draftSymbols.push({
        name: functionName,
        kind: "function",
        signature: singleLineSignature(`${child.text} ${nodeText(bodyNode)}`),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(bodyNode)
      });
      if (exported) {
        exportLabels.push(functionName);
      }
      continue;
    }
    if (child.type === "mixin_declaration") {
      const mixinName = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
      if (!mixinName) {
        continue;
      }
      const bodyNode = child.childForFieldName("body") ?? findNamedChild(child, "class_body");
      const exported = !mixinName.startsWith("_");
      draftSymbols.push({
        name: mixinName,
        kind: "trait",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(bodyNode) || child.text
      });
      if (exported) {
        exportLabels.push(mixinName);
      }
      pushScopedFunctions(bodyNode, mixinName);
      continue;
    }
    if (child.type === "enum_declaration") {
      const enumName = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
      if (!enumName) {
        continue;
      }
      const exported = !enumName.startsWith("_");
      draftSymbols.push({
        name: enumName,
        kind: "enum",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body") ?? findNamedChild(child, "enum_body")) || child.text
      });
      if (exported) {
        exportLabels.push(enumName);
      }
      continue;
    }
    if (child.type === "extension_declaration") {
      const extensionName = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
      const targetType = extractIdentifier(child.childForFieldName("type") ?? findNamedChild(child, "type_identifier")) ?? extensionName;
      const bodyNode = child.childForFieldName("body") ?? findNamedChild(child, "extension_body");
      if (targetType) {
        pushScopedFunctions(bodyNode, targetType);
      }
      continue;
    }
    if (child.type !== "class_definition") {
      continue;
    }
    const className = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
    if (!className) {
      continue;
    }
    const superTypes = descendantTypeNames(child.childForFieldName("superclass"));
    const interfaceTypes = descendantTypeNames(child.childForFieldName("interfaces"));
    const bodyNode = child.childForFieldName("body") ?? findNamedChild(child, "class_body");
    const exported = !className.startsWith("_");
    draftSymbols.push({
      name: className,
      kind: "class",
      signature: singleLineSignature(child.text),
      exported,
      callNames: [],
      extendsNames: superTypes.slice(0, 1),
      implementsNames: [...superTypes.slice(1), ...interfaceTypes],
      bodyText: nodeText(bodyNode) || child.text
    });
    if (exported) {
      exportLabels.push(className);
    }
    pushScopedFunctions(bodyNode, className);
  }

  return finalizeCodeAnalysis(manifest, "dart", imports, draftSymbols, exportLabels, diagnostics, {
    namespace: libraryName
  });
}

function pythonCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "import_statement") {
      imports.push(...parsePythonImportStatement(child));
      continue;
    }
    if (child.type === "import_from_statement") {
      imports.push(...parsePythonFromImportStatement(child));
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
        const parsed = spec ? parseGoImport(spec) : undefined;
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
      imports.push(...parseRustUseDeclaration(child));
      continue;
    }
    if (child.type === "mod_item") {
      // `mod foo;` declares a child module that lives in a sibling file; this is the Rust
      // equivalent of a local import. An inline module `mod foo { ... }` has a
      // declaration_list child and is not an import of a sibling file.
      const hasInlineBody = child.namedChildren.some((item) => item?.type === "declaration_list");
      if (!hasInlineBody) {
        const modName = extractIdentifier(child.childForFieldName("name") ?? findNamedChild(child, "identifier"));
        if (modName) {
          imports.push({
            specifier: `self::${modName}`,
            importedSymbols: [],
            isExternal: false,
            reExport: false
          });
        }
      }
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
      const pathNode =
        child.namedChildren.find((inner): inner is TreeNode => inner?.type === "scoped_identifier" || inner?.type === "identifier") ?? null;
      const flattened = flattenJavaScopedIdentifier(pathNode);
      if (flattened) {
        packageName = flattened;
      }
      continue;
    }
    if (child.type === "import_declaration") {
      imports.push(parseJavaImport(child));
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
        const parsed = parseKotlinImport(importNode);
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
      imports.push(...parseScalaImport(child));
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
      const parsed = parseCSharpUsing(child);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }
    if (child.type === "file_scoped_namespace_declaration" || child.type === "namespace_declaration") {
      namespaceName = nodeText(child.childForFieldName("name")) || namespaceName;
      if (child.type === "namespace_declaration") {
        // Block-style namespaces wrap their members in a `declaration_list` child;
        // file-scoped namespaces put members directly at the compilation_unit level
        // and never reach this branch. Flatten one layer of `declaration_list` so
        // top-level classes are still discovered.
        const nameNode = child.childForFieldName("name");
        const namespaceMembers: TreeNode[] = [];
        for (const directChild of child.namedChildren) {
          if (!directChild || directChild === nameNode) {
            continue;
          }
          if (directChild.type === "declaration_list") {
            for (const inner of directChild.namedChildren) {
              if (inner) {
                namespaceMembers.push(inner);
              }
            }
            continue;
          }
          namespaceMembers.push(directChild);
        }
        for (const nested of namespaceMembers) {
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
      imports.push(...parsePhpUse(child));
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
            // `require_relative` is always resolved relative to the current file, even
            // for bare names like `require_relative "helper"`. Normalize bare names to a
            // `./` prefix so the downstream local-path resolver recognizes them.
            const normalizedSpecifier =
              callee === "require_relative" && !specifier.startsWith(".") && !specifier.startsWith("/") ? `./${specifier}` : specifier;
            imports.push({
              specifier: normalizedSpecifier,
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

// tree-sitter-swift exposes the `import` specifier as a single `identifier`
// named child whose text is the dotted module path (e.g. "Foundation" or
// "struct.Foo.Bar" when sub-item imports like `import struct Foo.Bar` are used).
// Reading that child's text directly avoids re-joining segments via descendant
// walks.
function parseSwiftImport(node: TreeNode): CodeImport | undefined {
  const identifierNode = findNamedChild(node, "identifier");
  if (!identifierNode) {
    return undefined;
  }
  const specifier = identifierNode.text.trim();
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    // Swift does not have file-local relative imports; every `import` references
    // an external module (Foundation, UIKit, a SwiftPM package product, or the
    // current target's own module). Mark them all as external so the dependency
    // aggregator groups them with other package-level graph edges.
    isExternal: true,
    reExport: false
  };
}

// Walk the anonymous keyword children of a `class_declaration` to find whether
// the declaration uses `class`, `struct`, or `enum`. tree-sitter-swift exposes
// each of these as a plain child whose `type` equals the keyword text — no
// regex or text inspection required.
function swiftDeclarationKindFromKeyword(node: TreeNode): CodeSymbolKind {
  for (const child of node.children) {
    if (!child) {
      continue;
    }
    if (child.type === "struct") {
      return "struct";
    }
    if (child.type === "enum") {
      return "enum";
    }
    if (child.type === "class") {
      return "class";
    }
  }
  return "class";
}

// Swift visibility is expressed as a `modifiers` child containing a
// `visibility_modifier`, whose innermost child carries the concrete keyword
// (public / private / fileprivate / internal / open). Missing visibility means
// `internal`, which Swift treats as module-accessible. For the SwarmVault
// graph's "exported" flag we treat everything except `private` and
// `fileprivate` as exported.
function swiftVisibilityKeyword(node: TreeNode): string | undefined {
  const modifiers = findNamedChild(node, "modifiers");
  if (!modifiers) {
    return undefined;
  }
  const visibility = findNamedChild(modifiers, "visibility_modifier");
  if (!visibility) {
    return undefined;
  }
  for (const kw of visibility.children) {
    if (!kw) {
      continue;
    }
    if (kw.type === "public" || kw.type === "private" || kw.type === "fileprivate" || kw.type === "internal" || kw.type === "open") {
      return kw.type;
    }
  }
  return undefined;
}

function swiftExported(node: TreeNode): boolean {
  const visibility = swiftVisibilityKeyword(node);
  return visibility !== "private" && visibility !== "fileprivate";
}

function swiftCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  // tree-sitter-swift exposes inherited types as a SEQUENCE of sibling
  // `inheritance_specifier` children on the declaration (one per comma-separated
  // parent), rather than a single specifier wrapping all of them. Walk every
  // such child and collect the parent type in declaration order so downstream
  // code can split the first entry (superclass) from the rest (protocols).
  const recordParentTypes = (declaration: TreeNode): string[] => {
    const specifiers = declaration.namedChildren.filter((item): item is TreeNode => item?.type === "inheritance_specifier");
    if (specifiers.length === 0) {
      return [];
    }
    const ordered: string[] = [];
    for (const specifier of specifiers) {
      // Prefer the specifier's direct named child (`user_type` or `type_identifier`)
      // so nested generic parameters don't leak additional type names into the
      // parent list.
      const primary =
        findNamedChild(specifier, "user_type") ??
        findNamedChild(specifier, "type_identifier") ??
        specifier.namedChildren.find((item): item is TreeNode => item !== null) ??
        null;
      if (!primary) {
        continue;
      }
      const name = normalizeSymbolReference(primary.text);
      if (name) {
        ordered.push(name);
      }
    }
    return uniqueBy(ordered, (item) => item);
  };

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }

    if (child.type === "import_declaration") {
      const parsed = parseSwiftImport(child);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    if (child.type === "protocol_declaration") {
      const name = extractIdentifier(findNamedChild(child, "type_identifier"));
      if (!name) {
        continue;
      }
      const parents = recordParentTypes(child);
      const exported = swiftExported(child);
      draftSymbols.push({
        name,
        kind: "interface",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: parents,
        implementsNames: [],
        bodyText: nodeText(findNamedChild(child, "protocol_body")) || child.text
      });
      if (exported) {
        exportLabels.push(name);
      }
      continue;
    }

    if (child.type === "class_declaration") {
      const name = extractIdentifier(findNamedChild(child, "type_identifier"));
      if (!name) {
        continue;
      }
      const kind = swiftDeclarationKindFromKeyword(child);
      // Swift class declarations list a single superclass followed by zero or
      // more protocol conformances, all inside `inheritance_specifier`. The
      // grammar does not label which entry is the superclass, so we apply the
      // Swift language rule: only the first type is eligible to be a concrete
      // superclass, and only when the declaration is a class. Structs and enums
      // have no superclass, so every parent type is a protocol conformance.
      const parentTypes = recordParentTypes(child);
      const extendsNames = kind === "class" && parentTypes.length > 0 ? [parentTypes[0]!] : [];
      const implementsNames = kind === "class" ? parentTypes.slice(1) : parentTypes;
      const exported = swiftExported(child);
      const body = findNamedChild(child, "class_body") ?? findNamedChild(child, "enum_class_body");
      draftSymbols.push({
        name,
        kind,
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames,
        implementsNames,
        bodyText: nodeText(body) || child.text
      });
      if (exported) {
        exportLabels.push(name);
      }
      continue;
    }

    if (child.type === "typealias_declaration") {
      const name = extractIdentifier(findNamedChild(child, "type_identifier"));
      if (!name) {
        continue;
      }
      const exported = swiftExported(child);
      draftSymbols.push({
        name,
        kind: "type_alias",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      if (exported) {
        exportLabels.push(name);
      }
      continue;
    }

    if (child.type === "function_declaration") {
      const name = extractIdentifier(findNamedChild(child, "simple_identifier") ?? findNamedChild(child, "identifier"));
      if (!name) {
        continue;
      }
      const exported = swiftExported(child);
      draftSymbols.push({
        name,
        kind: "function",
        signature: singleLineSignature(child.text),
        exported,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(findNamedChild(child, "function_body")) || child.text
      });
      if (exported) {
        exportLabels.push(name);
      }
      continue;
    }

    if (child.type === "property_declaration") {
      // Top-level `let`/`var` bindings become `variable` symbols. Tree-sitter
      // exposes the binding's name via a `pattern` child containing a
      // `simple_identifier`. A single declaration can bind multiple names
      // (`var a, b: Int`); walk all pattern children to capture each one.
      const exported = swiftExported(child);
      const patterns = child.namedChildren.filter((item): item is TreeNode => item?.type === "pattern");
      for (const pattern of patterns) {
        const name = extractIdentifier(findNamedChild(pattern, "simple_identifier") ?? pattern.namedChildren[0] ?? null);
        if (!name) {
          continue;
        }
        draftSymbols.push({
          name,
          kind: "variable",
          signature: singleLineSignature(child.text),
          exported,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: child.text
        });
        if (exported) {
          exportLabels.push(name);
        }
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "swift", imports, draftSymbols, exportLabels, diagnostics);
}

// Elixir's tree-sitter grammar is uniform: every top-level construct (`defmodule`,
// `defprotocol`, `def`, `defp`, `alias`, `import`, etc.) is represented as a `call`
// node whose first named child is an `identifier` holding the macro name, whose
// second named child is an `arguments` node, and which may have a trailing
// `do_block` for block-style forms. These helpers extract the pieces we care
// about by walking named children directly — no regex, no text scans.

function elixirCallIdentifier(callNode: TreeNode): string | undefined {
  return findNamedChild(callNode, "identifier")?.text.trim() || undefined;
}

// Read a module path from an `arguments` node. Elixir module paths come through
// the grammar as an `alias` node (e.g. `MyApp.Formatter`), but bare identifiers
// (e.g. `Logger` in `require Logger`) may also appear as `alias` or `identifier`.
// Walk the argument's named children in order and pick the first hit, matching
// the first positional argument a reader would expect to be the module path.
function elixirFirstModulePath(argumentsNode: TreeNode | null | undefined): string | undefined {
  if (!argumentsNode) {
    return undefined;
  }
  for (const child of argumentsNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "alias" || child.type === "identifier") {
      const text = child.text.trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

// Extract the function/macro name that a `def` / `defp` / `defmacro` / `defmacrop`
// call defines. The `arguments` node's first child takes one of two shapes:
//   1. A `call` whose identifier holds the name and whose own arguments hold the
//      parameter list: `def foo(a, b) do ... end`.
//   2. A bare `identifier`: `def foo, do: ...` or `def foo`.
function elixirFunctionNameFromArguments(argumentsNode: TreeNode | null | undefined): string | undefined {
  if (!argumentsNode) {
    return undefined;
  }
  const first = argumentsNode.namedChildren.find((item): item is TreeNode => item !== null);
  if (!first) {
    return undefined;
  }
  if (first.type === "call") {
    const inner = findNamedChild(first, "identifier");
    return inner?.text.trim() || undefined;
  }
  if (first.type === "identifier") {
    return first.text.trim() || undefined;
  }
  return undefined;
}

const ELIXIR_IMPORT_MACROS = new Set(["alias", "import", "require", "use"]);
const ELIXIR_PUBLIC_DEF_MACROS = new Set(["def", "defmacro"]);
const ELIXIR_PRIVATE_DEF_MACROS = new Set(["defp", "defmacrop"]);

function elixirCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  // Elixir module names are chosen by the developer inside `defmodule Foo.Bar do`
  // and do NOT mirror the filesystem layout the way Python or Rust modules do.
  // Remember the first top-level module we encounter so we can plumb it through
  // `finalizeCodeAnalysis` as the canonical moduleName; downstream import
  // resolution relies on that string to match `alias Foo.Bar` against this file.
  let primaryModuleName: string | undefined;

  // Walk every top-level `call`. Elixir files typically contain one or more
  // `defmodule`/`defprotocol` calls; everything else (top-level `alias`, bare
  // expressions) lives inside those module bodies in real code.
  for (const topCall of rootNode.namedChildren) {
    if (!topCall || topCall.type !== "call") {
      continue;
    }
    const macroName = elixirCallIdentifier(topCall);
    if (macroName !== "defmodule" && macroName !== "defprotocol") {
      continue;
    }

    const moduleArgs = findNamedChild(topCall, "arguments");
    const moduleName = elixirFirstModulePath(moduleArgs);
    if (!moduleName) {
      continue;
    }

    const moduleKind: CodeSymbolKind = macroName === "defprotocol" ? "interface" : "class";
    const moduleHeaderLine = topCall.text.split("\n")[0] ?? topCall.text;
    if (primaryModuleName === undefined) {
      primaryModuleName = moduleName;
    }
    draftSymbols.push({
      name: moduleName,
      kind: moduleKind,
      signature: singleLineSignature(moduleHeaderLine),
      // Modules and protocols are always module-level public in Elixir.
      exported: true,
      callNames: [],
      extendsNames: [],
      implementsNames: [],
      bodyText: topCall.text
    });
    exportLabels.push(moduleName);

    const doBlock = findNamedChild(topCall, "do_block");
    if (!doBlock) {
      continue;
    }

    // Walk the module's `do_block` for the calls that matter to the graph:
    // imports, function/macro definitions. Attribute calls (`@moduledoc`, `@doc`,
    // `@type`, ...) surface as `unary_operator` nodes and are intentionally skipped
    // here — the shared rationale walker picks them up separately via
    // commentNodes(), and the `@type` declaration's own `call` lives under the
    // operator where finalizeCodeAnalysis would not surface it in a useful way.
    for (const innerNode of doBlock.namedChildren) {
      if (!innerNode || innerNode.type !== "call") {
        continue;
      }
      const innerMacro = elixirCallIdentifier(innerNode);
      if (!innerMacro) {
        continue;
      }

      if (ELIXIR_IMPORT_MACROS.has(innerMacro)) {
        const importArgs = findNamedChild(innerNode, "arguments");
        const modulePath = elixirFirstModulePath(importArgs);
        if (!modulePath) {
          continue;
        }
        imports.push({
          specifier: modulePath,
          importedSymbols: [],
          // Elixir imports always target a compiled BEAM module; there is no
          // notion of "file-local" relative imports the way Python or JS use them.
          // Treat every entry as external.
          isExternal: true,
          reExport: false
        });
        continue;
      }

      if (ELIXIR_PUBLIC_DEF_MACROS.has(innerMacro) || ELIXIR_PRIVATE_DEF_MACROS.has(innerMacro)) {
        const innerArgs = findNamedChild(innerNode, "arguments");
        const fnName = elixirFunctionNameFromArguments(innerArgs);
        if (!fnName) {
          continue;
        }
        const qualifiedName = `${moduleName}.${fnName}`;
        const exported = ELIXIR_PUBLIC_DEF_MACROS.has(innerMacro);
        const headerLine = innerNode.text.split("\n")[0] ?? innerNode.text;
        draftSymbols.push({
          name: qualifiedName,
          kind: "function",
          signature: singleLineSignature(headerLine),
          exported,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: nodeText(findNamedChild(innerNode, "do_block")) || innerNode.text
        });
        if (exported) {
          exportLabels.push(qualifiedName);
        }
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "elixir", imports, draftSymbols, exportLabels, diagnostics, {
    moduleName: primaryModuleName
  });
}

// OCaml top-level declarations come in a handful of well-named shapes. Each one
// exposes its identifying name through an easily-discoverable child field:
//   - `open_module`   contains a `module_path` whose text is the opened module.
//   - `module_definition` wraps a `module_binding` with `module_name`.
//   - `module_type_definition` exposes the interface name via `module_type_name`.
//   - `type_definition` wraps a `type_binding` whose `type_constructor` child is the type name.
//   - `value_definition` wraps a `let_binding` whose `value_name` child is the value name,
//      with an optional `parameter` child that distinguishes function bindings
//      from simple value bindings.
// All helpers below walk named children directly; no regex, no text scraping.

function parseOCamlOpen(node: TreeNode): CodeImport | undefined {
  const modulePath = findNamedChild(node, "module_path");
  if (!modulePath) {
    return undefined;
  }
  const specifier = modulePath.text.trim();
  if (!specifier) {
    return undefined;
  }
  return {
    specifier,
    importedSymbols: [],
    // Every OCaml `open` references a compiled module; there is no file-local
    // "./sibling" form. Classify as external and let resolveCodeImport's single-
    // candidate short-circuit promote it to local when an alias matches.
    isExternal: true,
    reExport: false
  };
}

function ocamlValueBindingKind(letBinding: TreeNode | null | undefined): CodeSymbolKind | undefined {
  if (!letBinding) {
    return undefined;
  }
  // `let foo x y = ...` → function (has parameter child)
  // `let foo = value`   → variable (no parameter child)
  // `let () = ...`      → unit binding, skipped upstream
  const hasParameter = letBinding.namedChildren.some((child): child is TreeNode => child?.type === "parameter");
  return hasParameter ? "function" : "variable";
}

function ocamlTypeKind(typeBinding: TreeNode | null | undefined): CodeSymbolKind {
  if (!typeBinding) {
    return "type_alias";
  }
  // `type t = { ... }`          -> record_declaration child  -> struct
  // `type t = Foo | Bar`        -> variant_declaration child -> enum
  // `type t = another_type`      -> no structural child      -> type_alias
  for (const child of typeBinding.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === "record_declaration") {
      return "struct";
    }
    if (child.type === "variant_declaration") {
      return "enum";
    }
  }
  return "type_alias";
}

function ocamlCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }

    if (child.type === "open_module") {
      const parsed = parseOCamlOpen(child);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    if (child.type === "module_definition") {
      // tree-sitter-ocaml exposes `module_name`, `module_type_name`, and
      // `type_constructor` as terminal-ish nodes whose text IS the identifier
      // we want. extractIdentifier's allowed-type list does not cover these
      // OCaml-specific node names, so read the text directly instead of
      // recursing. The text has already been lexed by the parser — no regex.
      const binding = findNamedChild(child, "module_binding");
      const moduleNameNode = binding ? findNamedChild(binding, "module_name") : null;
      const name = moduleNameNode?.text.trim();
      if (!name) {
        continue;
      }
      draftSymbols.push({
        name,
        kind: "class",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        // OCaml's `let`/`module` bindings are exported from the containing
        // compilation unit unless an explicit `.mli` interface hides them.
        // Treat everything defined in a `.ml` file as exported; consumers who
        // want hiding should rely on the downstream interface-file merge.
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(findNamedChild(binding, "structure")) || child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "module_type_definition") {
      const nameNode = findNamedChild(child, "module_type_name");
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      draftSymbols.push({
        name,
        kind: "interface",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(findNamedChild(child, "signature")) || child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "type_definition") {
      const binding = findNamedChild(child, "type_binding");
      const typeConstructorNode = binding ? findNamedChild(binding, "type_constructor") : null;
      const name = typeConstructorNode?.text.trim();
      if (!name) {
        continue;
      }
      const kind = ocamlTypeKind(binding);
      draftSymbols.push({
        name,
        kind,
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "value_definition") {
      const binding = findNamedChild(child, "let_binding");
      if (!binding) {
        continue;
      }
      const valueNameNode = findNamedChild(binding, "value_name");
      const name = valueNameNode?.text.trim();
      if (!name) {
        // Skip bindings with no name (e.g. `let () = ...` unit-pattern entry points).
        continue;
      }
      const kind = ocamlValueBindingKind(binding) ?? "function";
      draftSymbols.push({
        name,
        kind,
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "ocaml", imports, draftSymbols, exportLabels, diagnostics);
}

// tree-sitter-objc exposes Objective-C top-level declarations through a small
// handful of shapes:
//   - preproc_include          (#import / #include) — parseCppInclude already
//     handles both `<system/Header.h>` and `"LocalHeader.h"` variants.
//   - protocol_declaration     @protocol Name <Parent1, Parent2> ... @end
//   - class_interface          @interface Name : Super <Protocols> ... @end
//   - class_implementation     @implementation Name ... @end
//   - function_definition      C-style free functions returning objc types
//
// Every named-thing-carrying node exposes its identifier as a plain `identifier`
// named child (not wrapped in a synthetic "name" field), so we walk named
// children directly. Parent classes and conformed protocols are found by
// inspecting the second `identifier` child (for @interface) and any
// `parameterized_arguments > type_name` descendants.
function objcCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  // An Objective-C file can legally contain BOTH `@interface Foo` and
  // `@implementation Foo` for the same class. When both are present, we only
  // emit the `@interface` entry (which captures the superclass + protocol list)
  // and skip the matching `@implementation` so the graph doesn't end up with
  // two different `symbol:id:foo` / `symbol:id:foo-2` entries for one class.
  const declaredClassNames = new Set<string>();

  // C-style function declarators return the name through recursively nested
  // `declarator` fields when the return type includes pointer qualifiers like
  // `NSString *formatName(...)`. This mirrors the helper used in cFamilyCodeAnalysis.
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
      const parsed = parseCppInclude(child);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    if (child.type === "protocol_declaration") {
      const nameNode = findNamedChild(child, "identifier");
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      // Parent protocols live inside `protocol_reference_list` as `identifier`
      // children, separated by anonymous `,` tokens.
      const refList = findNamedChild(child, "protocol_reference_list");
      const parents = refList
        ? uniqueBy(
            refList.namedChildren
              .filter((item): item is TreeNode => item?.type === "identifier")
              .map((item) => item.text.trim())
              .filter(Boolean),
            (item) => item
          )
        : [];
      draftSymbols.push({
        name,
        kind: "interface",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: parents,
        implementsNames: [],
        bodyText: child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "class_interface") {
      // The identifier children of `class_interface` are ordered: class name,
      // then superclass (if any) — `@interface Name : Super`. The `:` between
      // them is an anonymous token so it does not shift the named-child index.
      const identifierChildren = child.namedChildren.filter((item): item is TreeNode => item?.type === "identifier");
      const name = identifierChildren[0]?.text.trim();
      if (!name) {
        continue;
      }
      const superclass = identifierChildren[1]?.text.trim();
      // Conformed protocols live inside `parameterized_arguments` as `type_name`
      // children (or plain `identifier` for some grammar variants).
      const parameterized = findNamedChild(child, "parameterized_arguments");
      const protocols = parameterized
        ? uniqueBy(
            parameterized.namedChildren
              .filter((item): item is TreeNode => item?.type === "type_name" || item?.type === "identifier")
              .map((item) => item.text.trim())
              .filter(Boolean),
            (item) => item
          )
        : [];
      declaredClassNames.add(name);
      draftSymbols.push({
        name,
        kind: "class",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: superclass ? [superclass] : [],
        implementsNames: protocols,
        bodyText: child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "class_implementation") {
      const nameNode = findNamedChild(child, "identifier");
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      // Skip the duplicate if the same class was already declared via
      // `@interface` in this file.
      if (declaredClassNames.has(name)) {
        continue;
      }
      declaredClassNames.add(name);
      draftSymbols.push({
        name,
        kind: "class",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "function_definition") {
      const name = functionNameFromDeclarator(child.childForFieldName("declarator"));
      if (!name) {
        continue;
      }
      draftSymbols.push({
        name,
        kind: "function",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(child.childForFieldName("body")) || child.text
      });
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "objc", imports, draftSymbols, exportLabels, diagnostics);
}

// tree-sitter-rescript top-level shape:
//   - open_statement         `open ModuleName` — `module_identifier` child has the path
//   - module_declaration     `module Name = { ... }` — `module_binding` child wraps
//                            `module_identifier` (name) + `block` body
//   - type_declaration       `type foo = ...` — `type_binding` child has
//                            `type_identifier` (name) + optional `variant_type` /
//                            `record_type` subchild that disambiguates the kind
//   - let_declaration        `let name = expr` — `let_binding` child has
//                            `value_identifier` (name) + an expression; when that
//                            expression is a `function` node the binding is a
//                            function, otherwise it is a plain value.
function rescriptCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  const rescriptTypeKind = (typeBinding: TreeNode | null | undefined): CodeSymbolKind => {
    if (!typeBinding) {
      return "type_alias";
    }
    for (const child of typeBinding.namedChildren) {
      if (!child) {
        continue;
      }
      if (child.type === "variant_type") {
        return "enum";
      }
      if (child.type === "record_type") {
        return "struct";
      }
    }
    return "type_alias";
  };

  const rescriptLetBindingKind = (letBinding: TreeNode | null | undefined): CodeSymbolKind => {
    if (!letBinding) {
      return "variable";
    }
    // The binding's RHS is the last named child after `value_identifier` and
    // `=`. A `function` node marks the binding as a function definition.
    for (const child of letBinding.namedChildren) {
      if (child?.type === "function") {
        return "function";
      }
    }
    return "variable";
  };

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }

    if (child.type === "open_statement") {
      const identNode = findNamedChild(child, "module_identifier");
      const specifier = identNode?.text.trim();
      if (!specifier) {
        continue;
      }
      imports.push({
        specifier,
        importedSymbols: [],
        // ReScript modules resolve through the build system's own module graph;
        // they are never file-local in the Python "./relative" sense.
        isExternal: true,
        reExport: false
      });
      continue;
    }

    if (child.type === "module_declaration") {
      const binding = findNamedChild(child, "module_binding");
      const nameNode = binding ? findNamedChild(binding, "module_identifier") : null;
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      draftSymbols.push({
        name,
        kind: "class",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(findNamedChild(binding, "block")) || child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "type_declaration") {
      const binding = findNamedChild(child, "type_binding");
      const nameNode = binding ? findNamedChild(binding, "type_identifier") : null;
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      const kind = rescriptTypeKind(binding);
      draftSymbols.push({
        name,
        kind,
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "let_declaration") {
      const binding = findNamedChild(child, "let_binding");
      const nameNode = binding ? findNamedChild(binding, "value_identifier") : null;
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      const kind = rescriptLetBindingKind(binding);
      draftSymbols.push({
        name,
        kind,
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "rescript", imports, draftSymbols, exportLabels, diagnostics);
}

// tree-sitter-solidity top-level shape:
//   - pragma_directive        pragma solidity ^0.8.20;
//   - import_directive        import "./Foo.sol";  OR
//                             import {Name} from "./Foo.sol"; (with identifier
//                             children for each imported symbol and a `string`
//                             child for the path)
//   - interface_declaration   interface Name { ... }        -> kind: interface
//   - library_declaration     library Name { ... }          -> kind: class
//   - contract_declaration    contract Name is A, B { ... } -> kind: class,
//                             inheritance_specifier children under an `is` token
//                             carry the parent contracts as `user_defined_type`
//   - struct_declaration      struct Name { ... }           -> kind: struct
//   - enum_declaration        enum Name { ... }             -> kind: enum
// Solidity supports genuine multiple inheritance (`contract C is A, B, C`), so
// we emit every parent as an `implementsNames` entry rather than arbitrarily
// picking the first as `extends` the way Swift/OCaml-ish languages do. This
// keeps the graph edges honest about the language's real semantics.
function parseSolidityImport(node: TreeNode): CodeImport[] {
  const stringNode = node.namedChildren.find((item): item is TreeNode => item?.type === "string");
  if (!stringNode) {
    return [];
  }
  // tree-sitter-solidity's `string` node text retains its surrounding quotes.
  // quotedPath strips the outer `"` / `'` and any whitespace.
  const specifier = quotedPath(stringNode.text);
  if (!specifier) {
    return [];
  }
  const importedSymbols = uniqueBy(
    node.namedChildren
      .filter((item): item is TreeNode => item?.type === "identifier")
      .map((item) => item.text.trim())
      .filter(Boolean),
    (item) => item
  );
  // Solidity file imports use relative paths (`./Foo.sol`, `../lib/Bar.sol`) for
  // local-within-repo targets and either absolute paths (`/abs/...`) or bare
  // package references (`@openzeppelin/contracts/...`) for third-party code.
  const isLocal = specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
  return [
    {
      specifier,
      importedSymbols,
      isExternal: !isLocal,
      reExport: false
    }
  ];
}

function solidityCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];

  const collectParents = (declaration: TreeNode): string[] => {
    const specifiers = declaration.namedChildren.filter((item): item is TreeNode => item?.type === "inheritance_specifier");
    const names: string[] = [];
    for (const specifier of specifiers) {
      for (const node of specifier.namedChildren) {
        if (node && (node.type === "user_defined_type" || node.type === "identifier")) {
          const text = normalizeSymbolReference(node.text);
          if (text) {
            names.push(text);
          }
        }
      }
    }
    return uniqueBy(names, (item) => item);
  };

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }

    if (child.type === "import_directive") {
      for (const parsed of parseSolidityImport(child)) {
        imports.push(parsed);
      }
      continue;
    }

    if (child.type === "interface_declaration") {
      const nameNode = findNamedChild(child, "identifier");
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      const parents = collectParents(child);
      draftSymbols.push({
        name,
        kind: "interface",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: parents,
        implementsNames: [],
        bodyText: nodeText(findNamedChild(child, "contract_body")) || child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "library_declaration" || child.type === "contract_declaration") {
      const nameNode = findNamedChild(child, "identifier");
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      const parents = child.type === "contract_declaration" ? collectParents(child) : [];
      draftSymbols.push({
        name,
        kind: "class",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        // Solidity supports multiple inheritance; list every parent contract
        // as a `implements` edge rather than arbitrarily promoting one to
        // `extends`.
        implementsNames: parents,
        bodyText: nodeText(findNamedChild(child, "contract_body")) || child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "struct_declaration") {
      const nameNode = findNamedChild(child, "identifier");
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      draftSymbols.push({
        name,
        kind: "struct",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "enum_declaration") {
      const nameNode = findNamedChild(child, "identifier");
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      draftSymbols.push({
        name,
        kind: "enum",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: child.text
      });
      exportLabels.push(name);
      continue;
    }

    if (child.type === "function_definition") {
      // Top-level free functions (Solidity 0.7+).
      const nameNode = findNamedChild(child, "identifier");
      const name = nameNode?.text.trim();
      if (!name) {
        continue;
      }
      draftSymbols.push({
        name,
        kind: "function",
        signature: singleLineSignature(child.text.split("\n")[0] ?? child.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: nodeText(findNamedChild(child, "function_body")) || child.text
      });
      exportLabels.push(name);
    }
  }

  return finalizeCodeAnalysis(manifest, "solidity", imports, draftSymbols, exportLabels, diagnostics);
}

// tree-sitter-html's tree is structural (nested `element` nodes, `attribute`
// children with `attribute_name` + `quoted_attribute_value`). For SwarmVault
// purposes HTML files are mostly not "code" in the symbol-extraction sense, so
// we focus on two graph-useful signals:
//   1. Imports: `<link rel="stylesheet" href="./x.css">` and `<script src="./y.js">`
//      point at first-party sibling assets and should become import edges.
//   2. Symbols: custom elements (tag names containing a `-`, e.g.
//      `<my-widget>`) and elements carrying an `id="..."` attribute become
//      class-kind symbols so the graph has named anchors to reason about.
// Plain structural tags (`<div>`, `<p>`, ...) are intentionally NOT emitted to
// keep the graph from drowning in structural noise.

function htmlAttributeValue(attribute: TreeNode): string | undefined {
  // An `attribute` node's second named child is either `quoted_attribute_value`
  // (double- or single-quoted) or `attribute_value` (unquoted). Both expose
  // their content as a `string_content`/`attribute_value_content` or as a
  // child whose text IS the content (with quotes already consumed).
  const quoted = attribute.namedChildren.find((c): c is TreeNode => c?.type === "quoted_attribute_value");
  if (quoted) {
    const inner = quoted.namedChildren.find((c): c is TreeNode => c?.type === "attribute_value");
    if (inner) {
      return inner.text.trim();
    }
    // Fall back to stripping the outer quote characters from the full node
    // text. The parser has already delimited the node so slicing off the first
    // and last char is safe.
    const raw = quoted.text;
    if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'")) {
      return raw.slice(1, -1).trim();
    }
    return raw.trim();
  }
  const bare = attribute.namedChildren.find((c): c is TreeNode => c?.type === "attribute_value");
  return bare?.text.trim();
}

function htmlAttributesOf(element: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const startTag = findNamedChild(element, "start_tag") ?? findNamedChild(element, "self_closing_tag");
  if (!startTag) {
    return out;
  }
  for (const child of startTag.namedChildren) {
    if (!child || child.type !== "attribute") {
      continue;
    }
    const nameNode = findNamedChild(child, "attribute_name");
    const name = nameNode?.text.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const value = htmlAttributeValue(child);
    if (value !== undefined) {
      out.set(name, value);
    }
  }
  return out;
}

function htmlTagName(element: TreeNode): string | undefined {
  const startTag = findNamedChild(element, "start_tag") ?? findNamedChild(element, "self_closing_tag") ?? null;
  if (!startTag) {
    return undefined;
  }
  return findNamedChild(startTag, "tag_name")?.text.trim().toLowerCase();
}

function htmlCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const seenSymbolNames = new Set<string>();

  const isLocalAssetSpecifier = (specifier: string): boolean => {
    if (!specifier) {
      return false;
    }
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
      return true;
    }
    if (specifier.startsWith("http://") || specifier.startsWith("https://") || specifier.startsWith("//")) {
      return false;
    }
    // Bare `widget.js` — treat as local repo-relative sibling.
    return !specifier.includes(":");
  };

  // Walk every element and script_element descendant once. For large HTML
  // documents this can be many nodes, but the grammar tree is small relative
  // to the source, and we filter aggressively to emit only graph-useful items.
  const elements = rootNode
    .descendantsOfType(["element", "script_element", "style_element"])
    .filter((item): item is TreeNode => item !== null);

  for (const element of elements) {
    const attrs = htmlAttributesOf(element);
    const tagName = htmlTagName(element);

    // Imports from <link rel="stylesheet" href="...">
    if (tagName === "link") {
      const rel = attrs.get("rel");
      const href = attrs.get("href");
      if (rel === "stylesheet" && href) {
        imports.push({
          specifier: href,
          importedSymbols: [],
          isExternal: !isLocalAssetSpecifier(href),
          reExport: false
        });
      }
      continue;
    }

    // Imports from <script src="...">
    if (element.type === "script_element") {
      const src = attrs.get("src");
      if (src) {
        imports.push({
          specifier: src,
          importedSymbols: [],
          isExternal: !isLocalAssetSpecifier(src),
          reExport: false
        });
      }
      continue;
    }

    // Symbols: custom elements (tag name contains `-`) become class-kind symbols.
    if (tagName?.includes("-")) {
      if (!seenSymbolNames.has(tagName)) {
        seenSymbolNames.add(tagName);
        draftSymbols.push({
          name: tagName,
          kind: "class",
          signature: singleLineSignature(element.text.split("\n")[0] ?? element.text),
          exported: true,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: element.text
        });
        exportLabels.push(tagName);
      }
    }

    // Symbols: any element with an id attribute becomes a variable-kind symbol
    // (a named anchor in the document), regardless of tag name.
    const id = attrs.get("id");
    if (id && !seenSymbolNames.has(id)) {
      seenSymbolNames.add(id);
      draftSymbols.push({
        name: id,
        kind: "variable",
        signature: singleLineSignature(element.text.split("\n")[0] ?? element.text),
        exported: true,
        callNames: [],
        extendsNames: [],
        implementsNames: [],
        bodyText: element.text
      });
      exportLabels.push(id);
    }
  }

  return finalizeCodeAnalysis(manifest, "html", imports, draftSymbols, exportLabels, diagnostics);
}

// tree-sitter-css top-level shape:
//   - import_statement   `@import "path.css";` or `@import url("path.css");`
//                        The path lives in a `string_value` child of the
//                        import_statement, or in a nested
//                        `call_expression > arguments > string_value` when
//                        `url(...)` form is used.
//   - rule_set           Each CSS rule wraps `selectors` + `block`. We use the
//                        `selectors` text as the symbol name and classify as
//                        `class` kind — it's the closest match in the constrained
//                        CodeSymbolKind set for "named-collection-of-rules".
//   - keyframes_statement  `@keyframes name { ... }` — emit `name` as a class symbol.
// Selectors inside `@media`/`@supports` blocks are intentionally not walked in
// this first pass because they are wrapped in a separate `media_statement` node
// and the rule set is nested one level deeper; supporting them is a follow-up.
function parseCssImport(node: TreeNode): CodeImport | undefined {
  // Direct form: `@import "./foo.css";` — string_value is a direct child.
  const directString = node.namedChildren.find((c): c is TreeNode => c?.type === "string_value");
  if (directString) {
    const specifier = quotedPath(directString.text);
    if (!specifier) {
      return undefined;
    }
    return {
      specifier,
      importedSymbols: [],
      isExternal: !(specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")),
      reExport: false
    };
  }
  // url() form: `@import url("./foo.css");` — dig through call_expression.
  const call = node.namedChildren.find((c): c is TreeNode => c?.type === "call_expression");
  if (call) {
    const args = findNamedChild(call, "arguments");
    const stringNode = args?.namedChildren.find((c): c is TreeNode => c?.type === "string_value");
    if (stringNode) {
      const specifier = quotedPath(stringNode.text);
      if (!specifier) {
        return undefined;
      }
      return {
        specifier,
        importedSymbols: [],
        isExternal: !(specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")),
        reExport: false
      };
    }
  }
  return undefined;
}

function cssCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const seenSymbols = new Set<string>();

  const addSelectorSymbol = (name: string, ruleText: string) => {
    const trimmed = name.trim();
    if (!trimmed || seenSymbols.has(trimmed)) {
      return;
    }
    seenSymbols.add(trimmed);
    draftSymbols.push({
      name: trimmed,
      kind: "class",
      signature: singleLineSignature(ruleText.split("\n")[0] ?? ruleText),
      exported: true,
      callNames: [],
      extendsNames: [],
      implementsNames: [],
      bodyText: ruleText
    });
    exportLabels.push(trimmed);
  };

  for (const child of rootNode.namedChildren) {
    if (!child) {
      continue;
    }

    if (child.type === "import_statement") {
      const parsed = parseCssImport(child);
      if (parsed) {
        imports.push(parsed);
      }
      continue;
    }

    if (child.type === "rule_set") {
      const selectors = findNamedChild(child, "selectors");
      if (!selectors) {
        continue;
      }
      // Use the full selector text as the symbol name. tree-sitter-css already
      // parsed it, so `normalizeWhitespace` collapses multi-line selectors to
      // a single logical name without touching selector semantics.
      const selectorText = normalizeWhitespace(selectors.text);
      addSelectorSymbol(selectorText, child.text);
      continue;
    }

    if (child.type === "keyframes_statement") {
      // `@keyframes name { ... }` — the keyframe name is a plain identifier
      // (type `keyframes_name` or `plain_value`) as a named child.
      const nameNode = child.namedChildren.find((c): c is TreeNode => c?.type === "keyframes_name" || c?.type === "plain_value");
      const name = nameNode?.text.trim();
      if (name) {
        addSelectorSymbol(`@keyframes ${name}`, child.text);
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "css", imports, draftSymbols, exportLabels, diagnostics);
}

// tree-sitter-vue's root is a `component` with direct children for
// `script_element`, `template_element`, and `style_element`. Each section
// exposes a `start_tag` (with attributes) and a `raw_text` payload for script
// and style. Inside `template_element`, the element tree mirrors HTML's shape.
//
// For this first-pass adapter we:
//   1. Emit a single class symbol whose name is the SFC basename (e.g.
//      `Widget.vue` -> `Widget`) so downstream import-by-filename resolves.
//   2. Walk elements inside the template for ids and PascalCase tag names
//      (Vue's component-reference convention); those become variable and
//      class symbols respectively.
// We intentionally DO NOT attempt to nest-parse the script block's embedded
// JS/TS here; that would require re-invoking the TypeScript analyzer on the
// `raw_text`, which changes the shape of `analyzeTreeSitterCode` and is a
// follow-up. The SFC is still classified as `vue` and contributes the
// outer component symbol to the graph.
function vueCodeAnalysis(manifest: SourceManifest, rootNode: TreeNode, diagnostics: CodeDiagnostic[]): CodeAnalysis {
  const imports: CodeImport[] = [];
  const draftSymbols: DraftCodeSymbol[] = [];
  const exportLabels: string[] = [];
  const seenSymbols = new Set<string>();

  // SFC filename-derived component name. manifestBasename-like: take the
  // original path's basename without extension.
  const repoPath = manifest.repoRelativePath ?? path.basename(manifest.originalPath ?? manifest.storedPath);
  const basename = path.posix.basename(stripCodeExtension(toPosix(repoPath)));
  if (basename) {
    seenSymbols.add(basename);
    draftSymbols.push({
      name: basename,
      kind: "class",
      signature: `vue component ${basename}`,
      exported: true,
      callNames: [],
      extendsNames: [],
      implementsNames: [],
      bodyText: rootNode.text
    });
    exportLabels.push(basename);
  }

  const templateElement = rootNode.namedChildren.find((c): c is TreeNode => c?.type === "template_element");
  if (templateElement) {
    const elements = templateElement.descendantsOfType(["element"]).filter((item): item is TreeNode => item !== null);
    for (const element of elements) {
      const tagName = htmlTagName(element);
      const attrs = htmlAttributesOf(element);

      // Vue custom-component convention: tag names start with uppercase
      // (PascalCase). We can detect that from the original (case-sensitive)
      // tag_name text rather than the lowercased helper result.
      const startTag = findNamedChild(element, "start_tag") ?? findNamedChild(element, "self_closing_tag") ?? null;
      const rawTagName = startTag ? findNamedChild(startTag, "tag_name")?.text.trim() : undefined;
      if (rawTagName && /^[A-Z]/.test(rawTagName) && !seenSymbols.has(rawTagName)) {
        seenSymbols.add(rawTagName);
        draftSymbols.push({
          name: rawTagName,
          kind: "class",
          signature: singleLineSignature(element.text.split("\n")[0] ?? element.text),
          exported: true,
          callNames: [],
          extendsNames: [],
          implementsNames: [],
          bodyText: element.text
        });
        exportLabels.push(rawTagName);
      }

      // Non-custom elements with id="..." become variable symbols (stable
      // anchors inside the template).
      if (tagName && !tagName.includes("-") && !(rawTagName && /^[A-Z]/.test(rawTagName))) {
        const id = attrs.get("id");
        if (id && !seenSymbols.has(id)) {
          seenSymbols.add(id);
          draftSymbols.push({
            name: id,
            kind: "variable",
            signature: singleLineSignature(element.text.split("\n")[0] ?? element.text),
            exported: true,
            callNames: [],
            extendsNames: [],
            implementsNames: [],
            bodyText: element.text
          });
          exportLabels.push(id);
        }
      }
    }
  }

  return finalizeCodeAnalysis(manifest, "vue", imports, draftSymbols, exportLabels, diagnostics);
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
      const parsed = parseCppInclude(child);
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
  // The vendored Swift grammar currently triggers multi-gigabyte V8 wasm
  // compilation spikes on Node 24, which crashes local test and OSS-corpus
  // runs before any actual Swift AST walk happens. Keep Swift on the
  // documented "unsupported but graceful" path unless a caller explicitly
  // opts in for local experimentation.
  if (language === "swift" && !swiftTreeSitterEnabled()) {
    return {
      code: finalizeCodeAnalysis(manifest, language, [], [], [], [swiftTreeSitterDisabledDiagnostic()]),
      rationales: []
    };
  }

  // Preprocessor directives confuse tree-sitter-c / tree-sitter-cpp /
  // tree-sitter-c-sharp when they interrupt a statement or expression. Neutralise
  // them before parsing by always taking the first `#if` branch and blanking every
  // directive line plus every line inside non-taken branches. Line numbers are
  // preserved so any remaining diagnostics still point at the right source line.
  const parseInput = language === "c" || language === "cpp" || language === "csharp" ? neutralizePreprocessorDirectives(content) : content;
  let tree: Tree | null = null;
  try {
    const module = await getTreeSitterModule();
    await ensureTreeSitterInit(module);
    const parser = new module.Parser();
    parser.setLanguage(await loadLanguage(language));
    tree = parser.parse(parseInput);
  } catch (error) {
    const diagnostic = treeSitterCompatibilityDiagnostic(language, error);
    // Downgrade the known tree-sitter-bash initialisation flake so a single transient
    // wasm failure on one shell script does not mark the whole source as broken.
    if (language === "bash" && typeof diagnostic.message === "string" && diagnostic.message.includes("resolved is not a function")) {
      diagnostic.category = "warning";
    }
    return {
      code: finalizeCodeAnalysis(manifest, language, [], [], [], [diagnostic]),
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
    // tree-sitter-lua@0.1.13 leaks wasm state across parses: the first Lua source in a
    // session parses cleanly, but every subsequent Lua source inherits a poisoned parser
    // state and reports spurious "syntax error" nodes on fundamentally valid code (e.g.
    // `require(...)` calls or empty `{}` table constructors). The descendant-based symbol
    // and import walkers below still work against the corrupted tree because they find
    // nodes by type rather than by structural position, so the actual extraction stays
    // correct; only the grammar-level diagnostics are unreliable. Suppress them for Lua.
    // Lua's tree-sitter grammar leaks wasm state across parses (see earlier fix) —
    // suppress its diagnostics. For bash, suppress diagnostics whenever the source
    // is actually zsh; tree-sitter-bash cannot parse zsh-only constructs but the
    // descendant-type walkers still find functions and `source` edges correctly.
    const suppressDiagnostics = language === "lua" || (language === "bash" && detectShellDialect(content) === "zsh");
    const rawDiagnostics = suppressDiagnostics ? [] : diagnosticsFromTree(tree.rootNode);
    // Tree-sitter grammars for C, C++, C#, and Bash have well-known gaps: C and C++
    // don't run the preprocessor, so macro-prefixed declarations like
    // `JSON_EXPORT struct foo *bar();` confuse the parser; tree-sitter-c-sharp
    // doesn't handle several newer C# features (verbatim/interpolated strings in
    // some positions, pattern-matching extensions); tree-sitter-bash cannot parse
    // zsh at all. These grammar gaps produce "syntax errors" on code that actually
    // compiles fine. Downgrade them from `error` to `warning` so users still see
    // the signal that parsing was imperfect without the sources looking broken.
    const grammarGappedLanguages: ReadonlySet<string> = new Set(["c", "cpp", "csharp", "bash"]);
    const diagnostics = grammarGappedLanguages.has(language)
      ? rawDiagnostics.map((d) => (d.category === "error" ? { ...d, category: "warning" as const } : d))
      : rawDiagnostics;
    const rationales = extractTreeSitterRationales(manifest, language, tree.rootNode);
    switch (language) {
      case "bash":
        return { code: bashCodeAnalysis(manifest, tree.rootNode, diagnostics, content), rationales };
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
      case "dart":
        return { code: dartCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
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
      case "swift":
        return { code: swiftCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "elixir":
        return { code: elixirCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "ocaml":
        return { code: ocamlCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "objc":
        return { code: objcCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "rescript":
        return { code: rescriptCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "solidity":
        return { code: solidityCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "html":
        return { code: htmlCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "css":
        return { code: cssCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
      case "vue":
        return { code: vueCodeAnalysis(manifest, tree.rootNode, diagnostics), rationales };
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
