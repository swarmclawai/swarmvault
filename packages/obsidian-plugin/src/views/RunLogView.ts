import { ItemView } from "obsidian";
import { VIEW_TYPE_RUN_LOG } from "../constants";

export interface RunLogEntry {
  id: string;
  command: string;
  args: readonly string[];
  startedAt: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  durationMs: number | null;
  stderr: string[];
  stdout: string[];
  cancel: () => void;
}

export class RunLogView extends ItemView {
  private readonly entries: RunLogEntry[] = [];
  private readonly nodes = new Map<string, HTMLElement>();

  getViewType(): string {
    return VIEW_TYPE_RUN_LOG;
  }

  getDisplayText(): string {
    return "SwarmVault: Run log";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.nodes.clear();
  }

  recordEntry(entry: RunLogEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > 100) this.entries.pop();
    this.render();
  }

  appendStderr(id: string, line: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.stderr.push(line);
    this.renderEntry(entry);
  }

  appendStdout(id: string, line: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.stdout.push(line);
    this.renderEntry(entry);
  }

  finishEntry(id: string, patch: Partial<Pick<RunLogEntry, "status" | "exitCode" | "durationMs">>): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.renderEntry(entry);
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("swarmvault-run-log");

    const header = container.createEl("div", { cls: "swarmvault-run-log__header" });
    header.createEl("h3", { text: "SwarmVault run log" });
    header.createEl("div", { text: `${this.entries.length} recent` });

    if (this.entries.length === 0) {
      container.createEl("p", {
        text: "No commands have been run yet. Use the command palette to invoke a SwarmVault command.",
        cls: "swarmvault-run-log__empty"
      });
      return;
    }

    this.nodes.clear();
    for (const entry of this.entries) {
      const entryEl = container.createEl("div", { cls: "swarmvault-run-log__entry" });
      this.nodes.set(entry.id, entryEl);
      this.renderEntry(entry);
    }
  }

  private renderEntry(entry: RunLogEntry): void {
    const el = this.nodes.get(entry.id);
    if (!el) return;
    el.empty();

    const summary = el.createEl("div", { cls: "swarmvault-run-log__summary" });
    summary.createEl("code", { text: `${entry.command} ${entry.args.join(" ")}`.trim() });
    const statusLabel = entry.status === "running" ? "running" : entry.status;
    summary.createEl("span", { text: ` — ${statusLabel}` });
    if (typeof entry.exitCode === "number") {
      summary.createEl("span", { text: ` (exit ${entry.exitCode})` });
    }
    if (typeof entry.durationMs === "number") {
      summary.createEl("span", { text: ` — ${(entry.durationMs / 1000).toFixed(1)}s` });
    }

    if (entry.status === "running") {
      const cancelBtn = summary.createEl("button", { text: "Cancel" });
      cancelBtn.onclick = () => entry.cancel();
    }

    if (entry.stderr.length > 0) {
      const stderr = el.createEl("pre", { cls: "swarmvault-run-log__stderr" });
      stderr.setText(entry.stderr.slice(-200).join("\n"));
    }
    if (entry.stdout.length > 0) {
      const stdout = el.createEl("pre", { cls: "swarmvault-run-log__stdout" });
      stdout.setText(entry.stdout.slice(-200).join("\n"));
    }
  }
}
