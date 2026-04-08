# Troubleshooting

## `swarmvault` command not found

The ClawHub skill does not bundle the CLI binary by itself. Install the published package and verify it:

```bash
npm install -g @swarmvaultai/cli
swarmvault --version
```

If the binary still is not found, check that npm's global bin directory is on `PATH`.

## Node version too old

SwarmVault requires Node `>=24`.

```bash
node --version
```

Upgrade Node before troubleshooting provider or compile behavior.

## The vault compiles, but quality is weak

Check whether the vault is still using the built-in `heuristic` provider. That is useful for smoke tests and offline fallback, but not for serious synthesis quality. Configure a real provider in `swarmvault.config.json`.

## `wiki/graph/report.md` or search artifacts are missing

Run:

```bash
swarmvault compile
```

Then verify:

- `wiki/graph/report.md`
- `state/graph.json`
- `state/search.sqlite`

## Agent install or hooks seem stale

Re-run the relevant install command in the project root:

```bash
swarmvault install --agent claude --hook
swarmvault install --agent gemini --hook
swarmvault install --agent opencode --hook
swarmvault install --agent copilot --hook
```

For Aider:

```bash
swarmvault install --agent aider
```

## Update paths

Update the skill:

```bash
clawhub update swarmvault
```

Update the CLI:

```bash
npm install -g @swarmvaultai/cli@latest
```

## More Help

- Docs: https://www.swarmvault.ai/docs
- Providers: https://www.swarmvault.ai/docs/providers
- Web troubleshooting: https://www.swarmvault.ai/docs/getting-started/troubleshooting
- GitHub issues: https://github.com/swarmclawai/swarmvault/issues
