import { FileSystemAdapter, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import cliCompat from "../cli-compat.json";
import { ManagedProcesses } from "./cli/managed-processes";
import { CliRunner } from "./cli/run";
import { compareSemver, probeCliVersion } from "./cli/version-check";
import { registerCommands } from "./commands/register";
import { VIEW_TYPE_RUN_LOG } from "./constants";
import { DEFAULT_SETTINGS, mergeSettings, type SwarmVaultSettings } from "./settings/defaults";
import { SwarmVaultSettingsTab } from "./settings/SettingsTab";
import { CliNotFoundError, type FreshnessLevel } from "./types";
import { StatusBar } from "./ui/StatusBar";
import { RunLogView } from "./views/RunLogView";
import { readFreshness } from "./workspace/freshness";
import { resolveWorkspaceRoot } from "./workspace/resolve-root";

const MIN_CLI_VERSION: string = cliCompat.minCliVersion;

export default class SwarmVaultPlugin extends Plugin {
  settings: SwarmVaultSettings = { ...DEFAULT_SETTINGS };
  cliRunner: CliRunner = new CliRunner();
  managedProcesses: ManagedProcesses = new ManagedProcesses();
  workspaceRoot: string | null = null;
  cliVersion: string | null = null;
  cliMissing = false;
  freshness: FreshnessLevel = "unknown";
  private statusBar: StatusBar | null = null;
  private runningCount = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_RUN_LOG, (leaf: WorkspaceLeaf) => new RunLogView(leaf));

    const statusEl = this.addStatusBarItem();
    this.statusBar = new StatusBar(statusEl, {
      onWorkspaceClick: () => this.revealWorkspaceRoot(),
      onRunLogClick: () => void this.ensureRunLog()
    });

    this.addSettingTab(new SwarmVaultSettingsTab(this.app, this));

    registerCommands(this);
    this.addCommand({
      id: "swarmvault-verify-cli",
      name: "Verify CLI",
      callback: async () => {
        await this.verifyCli();
      }
    });
    this.addCommand({
      id: "swarmvault-open-run-log",
      name: "Open run log",
      callback: () => void this.ensureRunLog()
    });

    await this.refreshWorkspace();
    this.renderStatusBar();

    void this.verifyCli({ silent: true });
  }

  onunload(): void {
    this.managedProcesses.stopAll();
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<SwarmVaultSettings> | null;
    this.settings = mergeSettings(loaded);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async refreshWorkspace(): Promise<void> {
    const base = this.getVaultBasePath();
    const resolution = resolveWorkspaceRoot(base, {
      override: this.settings.workspaceRootOverride || undefined
    });
    this.workspaceRoot = resolution.root;
    if (this.workspaceRoot) {
      await this.refreshFreshness();
    } else {
      this.freshness = "unknown";
    }
    this.renderStatusBar();
  }

  async refreshFreshness(): Promise<void> {
    if (!this.workspaceRoot) {
      this.freshness = "unknown";
      this.renderStatusBar();
      return;
    }
    const reading = await readFreshness(this.workspaceRoot);
    this.freshness = reading.level;
    this.renderStatusBar();
  }

  async ensureRunLog(): Promise<RunLogView> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RUN_LOG).find((leaf) => leaf.view instanceof RunLogView);
    if (existing?.view instanceof RunLogView) {
      this.app.workspace.revealLeaf(existing);
      return existing.view;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      throw new Error("Unable to open SwarmVault run log view.");
    }
    await leaf.setViewState({ type: VIEW_TYPE_RUN_LOG, active: true });
    if (leaf.view instanceof RunLogView) {
      this.app.workspace.revealLeaf(leaf);
      return leaf.view;
    }
    throw new Error("Run log view failed to initialize.");
  }

  statusBarTickRunning(delta: number): void {
    this.runningCount = Math.max(0, this.runningCount + delta);
    this.renderStatusBar();
  }

  updateStatusBar(patch: Partial<{ cliVersion: string | null; cliMissing: boolean }>): void {
    if ("cliVersion" in patch) this.cliVersion = patch.cliVersion ?? null;
    if ("cliMissing" in patch) this.cliMissing = patch.cliMissing ?? false;
    this.renderStatusBar();
  }

  private renderStatusBar(): void {
    this.statusBar?.update({
      workspaceRoot: this.workspaceRoot,
      cliVersion: this.cliVersion,
      cliMissing: this.cliMissing,
      freshness: this.freshness,
      runningCount: this.runningCount
    });
  }

  private revealWorkspaceRoot(): void {
    if (!this.workspaceRoot) {
      new Notice("No SwarmVault workspace detected.");
      return;
    }
    new Notice(`Workspace: ${this.workspaceRoot}`);
  }

  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return null;
  }

  private async verifyCli(opts: { silent?: boolean } = {}): Promise<void> {
    try {
      const info = await probeCliVersion(this.settings.cliBinary, this.cliRunner);
      this.updateStatusBar({ cliVersion: info.version, cliMissing: false });
      if (compareSemver(info.version, MIN_CLI_VERSION) < 0 && !opts.silent) {
        new Notice(
          `SwarmVault CLI ${info.version} is older than the required ${MIN_CLI_VERSION}. Run \`npm i -g @swarmvaultai/cli@latest\`.`,
          10_000
        );
      }
    } catch (err) {
      const missing = err instanceof CliNotFoundError;
      this.updateStatusBar({ cliVersion: null, cliMissing: missing });
      if (opts.silent) return;
      const message = missing
        ? "SwarmVault CLI not found. Install with `npm i -g @swarmvaultai/cli`."
        : err instanceof Error
          ? err.message
          : String(err);
      new Notice(message, 8_000);
    }
  }
}
