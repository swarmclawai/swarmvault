import { MarkdownView, Notice, TFile } from "obsidian";
import { rewriteCitations } from "../citations/rewrite";
import type SwarmVaultPlugin from "../main";
import { QueryModal, type QueryModalResult } from "../modals/QueryModal";
import { loadPageIdIndex } from "../workspace/page-id-index";
import { executeCli } from "./execute";

interface QueryJsonResult {
  answer?: string;
  savedPath?: string;
  error?: string;
}

export function runQueryFromNote(plugin: SwarmVaultPlugin): void {
  const initial = inferInitialQuestion(plugin);
  const hasSelection = Boolean(getSelectionText(plugin));
  new QueryModal(plugin.app, {
    initialQuestion: initial,
    defaultOutputMode: plugin.settings.defaultQueryOutputMode,
    hasSelection,
    onSubmit: (result) => executeQuery(plugin, result)
  }).open();
}

export function runAsk(plugin: SwarmVaultPlugin): void {
  new QueryModal(plugin.app, {
    defaultOutputMode: plugin.settings.defaultQueryOutputMode,
    hasSelection: false,
    onSubmit: (result) => executeQuery(plugin, result)
  }).open();
}

async function executeQuery(plugin: SwarmVaultPlugin, req: QueryModalResult): Promise<void> {
  const progress = new Notice("SwarmVault: querying…", 0);
  const args: string[] = ["query", req.question, "--format", req.format, "--json"];
  if (!req.save) args.push("--no-save");

  try {
    const res = await executeCli<QueryJsonResult>(plugin, {
      args,
      commandLabel: "SwarmVault: Query",
      notifyOnSuccess: () => null
    });
    progress.hide();
    const json = res.json;
    if (!json?.answer) {
      new Notice("Query returned no answer.");
      return;
    }
    if (json.error) {
      new Notice(`Query error: ${json.error}`);
      return;
    }

    let answerMarkdown = json.answer;
    if (plugin.workspaceRoot) {
      const index = await loadPageIdIndex(plugin.workspaceRoot);
      answerMarkdown = rewriteCitations(answerMarkdown, index);
    }

    await placeAnswer(plugin, req, answerMarkdown, json.savedPath ?? null);
  } catch {
    progress.hide();
    // executeCli already showed a notice.
  }
}

async function placeAnswer(plugin: SwarmVaultPlugin, req: QueryModalResult, answer: string, savedPath: string | null): Promise<void> {
  switch (req.outputMode) {
    case "inline-replace":
      replaceSelection(plugin, answer);
      return;
    case "append-note":
      appendToActive(plugin, answer);
      return;
    case "wiki-outputs": {
      if (!savedPath) {
        new Notice("CLI did not return a saved path. Falling back to append-to-note.");
        appendToActive(plugin, answer);
        return;
      }
      await openSavedPath(plugin, savedPath);
      return;
    }
    case "ephemeral-pane": {
      await openEphemeralPane(plugin, req.question, answer);
      return;
    }
  }
}

function replaceSelection(plugin: SwarmVaultPlugin, answer: string): void {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) {
    new Notice("No active markdown view for inline replace.");
    return;
  }
  view.editor.replaceSelection(answer);
}

function appendToActive(plugin: SwarmVaultPlugin, answer: string): void {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) {
    new Notice("No active markdown view to append to.");
    return;
  }
  const editor = view.editor;
  const lastLine = editor.lineCount() - 1;
  const lastLineLength = editor.getLine(lastLine).length;
  editor.replaceRange(`\n\n${answer}\n`, { line: lastLine, ch: lastLineLength });
}

async function openSavedPath(plugin: SwarmVaultPlugin, absPath: string): Promise<void> {
  const root = plugin.workspaceRoot;
  if (!root) {
    new Notice(`Answer saved to ${absPath}`);
    return;
  }
  const relative = absPath.startsWith(root) ? absPath.slice(root.length).replace(/^[\\/]+/, "") : absPath;
  const file = plugin.app.vault.getAbstractFileByPath(relative);
  if (file instanceof TFile) {
    await plugin.app.workspace.getLeaf(true).openFile(file);
  } else {
    new Notice(`Answer saved to ${absPath}`);
  }
}

async function openEphemeralPane(plugin: SwarmVaultPlugin, question: string, answer: string): Promise<void> {
  const leaf = plugin.app.workspace.getLeaf(true);
  const tmpName = `swarmvault-query-${Date.now()}.md`;
  try {
    const file = await plugin.app.vault.create(tmpName, `# ${question}\n\n${answer}\n`);
    await leaf.openFile(file);
    new Notice("Ephemeral note created. Delete when finished.", 4000);
  } catch {
    new Notice("Failed to open ephemeral pane. Falling back to append.");
    appendToActive(plugin, answer);
  }
}

function inferInitialQuestion(plugin: SwarmVaultPlugin): string {
  const selection = getSelectionText(plugin);
  if (selection) return selection;
  const active = plugin.app.workspace.getActiveFile();
  return active?.basename ?? "";
}

function getSelectionText(plugin: SwarmVaultPlugin): string | null {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) return null;
  const sel = view.editor.getSelection();
  return sel?.trim() ? sel.trim() : null;
}
