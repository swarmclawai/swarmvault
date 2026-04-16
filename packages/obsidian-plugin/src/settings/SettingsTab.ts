import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import { probeCliVersion } from "../cli/version-check";
import type SwarmVaultPlugin from "../main";
import { CliNotFoundError } from "../types";

export class SwarmVaultSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    readonly plugin: SwarmVaultPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "SwarmVault" });

    new Setting(containerEl)
      .setName("CLI binary path")
      .setDesc("Leave blank to use `swarmvault` from PATH, or point at an absolute binary path.")
      .addText((text) =>
        text
          .setPlaceholder("swarmvault")
          .setValue(plugin.settings.cliBinary)
          .onChange(async (value) => {
            plugin.settings.cliBinary = value.trim();
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Verify CLI")
      .setDesc("Run `swarmvault --version --json` and confirm the binary is reachable.")
      .addButton((btn) =>
        btn.setButtonText("Verify").onClick(async () => {
          btn.setDisabled(true).setButtonText("Verifying…");
          try {
            const info = await probeCliVersion(plugin.settings.cliBinary, plugin.cliRunner);
            new Notice(`SwarmVault CLI ${info.version} reachable.`);
            plugin.updateStatusBar({ cliVersion: info.version });
          } catch (err) {
            const message =
              err instanceof CliNotFoundError
                ? "CLI not found. Install with `npm i -g @swarmvaultai/cli`."
                : err instanceof Error
                  ? err.message
                  : String(err);
            new Notice(`Verify failed: ${message}`, 8000);
          } finally {
            btn.setDisabled(false).setButtonText("Verify");
          }
        })
      );

    new Setting(containerEl)
      .setName("Workspace root override")
      .setDesc("Leave blank to auto-detect by walking up for `swarmvault.schema.md`.")
      .addText((text) =>
        text
          .setPlaceholder("/absolute/path/to/workspace")
          .setValue(plugin.settings.workspaceRootOverride)
          .onChange(async (value) => {
            plugin.settings.workspaceRootOverride = value.trim();
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default query output mode")
      .setDesc("Where `Query from current note` writes its answer by default.")
      .addDropdown((dd) =>
        dd
          .addOption("inline-replace", "Replace selection")
          .addOption("append-note", "Append to note")
          .addOption("wiki-outputs", "Write to wiki/outputs/")
          .addOption("ephemeral-pane", "New ephemeral pane")
          .setValue(plugin.settings.defaultQueryOutputMode)
          .onChange(async (value) => {
            plugin.settings.defaultQueryOutputMode = value as typeof plugin.settings.defaultQueryOutputMode;
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-compile on raw/ change")
      .setDesc("Spawn `swarmvault watch` to recompile whenever raw/ changes.")
      .addToggle((t) =>
        t.setValue(plugin.settings.autoCompileOnRawChange).onChange(async (v) => {
          plugin.settings.autoCompileOnRawChange = v;
          await plugin.saveSettings();
        })
      );
  }
}
