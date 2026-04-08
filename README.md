# SwarmVault

<!-- readme-language-nav:start -->
**Languages:** [English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)
<!-- readme-language-nav:end -->

[![npm](https://img.shields.io/npm/v/@swarmvaultai/cli)](https://www.npmjs.com/package/@swarmvaultai/cli)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)]()

**A local-first knowledge compiler for AI agents.** Turn raw files, URLs, and code into a persistent knowledge vault. Instead of losing work inside chat history, you get a markdown wiki, a knowledge graph, local search, and reviewable artifacts that stay on disk.

Documentation on the website is currently English-first. If wording drifts between translations, [README.md](README.md) is the canonical source.

> Most "chat with your docs" tools answer a question and throw away the work. SwarmVault treats the vault itself as the product. Every operation writes durable artifacts you can inspect, diff, and keep improving.

<!-- readme-section:install -->
## Install

SwarmVault requires Node `>=24`.

```bash
npm install -g @swarmvaultai/cli
```

Verify the install:

```bash
swarmvault --version
```

Update to the latest published release:

```bash
npm install -g @swarmvaultai/cli@latest
```

The global CLI already includes the graph viewer workflow and MCP server flow. End users do not need to install `@swarmvaultai/viewer` separately.

<!-- readme-section:quickstart -->
## Quickstart

```text
my-vault/
├── swarmvault.schema.md       user-editable vault instructions
├── raw/                       immutable source files and localized assets
├── wiki/                      compiled wiki: sources, concepts, entities, code, outputs, graph
├── state/                     graph.json, search.sqlite, embeddings, sessions, approvals
├── .obsidian/                 optional Obsidian workspace config
└── agent/                     generated agent-facing helpers
```

![SwarmVault graph workspace](https://www.swarmvault.ai/images/screenshots/graph-workspace.png)

```bash
swarmvault init --obsidian
swarmvault ingest ./src --repo-root .
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault compile
swarmvault query "What is the auth flow?"
swarmvault graph serve
swarmvault graph push neo4j --dry-run
```

<!-- readme-section:provider-setup -->
## Configure a Real Provider

The built-in `heuristic` provider is useful for smoke tests and offline defaults, but it is not meant for serious synthesis quality. For real compile and query work, point the vault at a proper model provider:

```json
{
  "providers": {
    "primary": {
      "type": "openai",
      "model": "gpt-4o",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  },
  "tasks": {
    "compileProvider": "primary",
    "queryProvider": "primary",
    "embeddingProvider": "primary"
  }
}
```

See the [provider docs](https://www.swarmvault.ai/docs/providers) for other supported backends and configuration examples.

<!-- readme-section:agent-setup -->
## Agent and MCP Setup

Set up your coding agent so it knows about the vault:

```bash
swarmvault install --agent claude --hook    # Claude Code + graph-first hook
swarmvault install --agent codex            # Codex
swarmvault install --agent cursor           # Cursor
swarmvault install --agent copilot --hook   # GitHub Copilot CLI + hook
swarmvault install --agent gemini --hook    # Gemini CLI + hook
```

Or expose the vault directly over MCP:

```bash
swarmvault mcp
```

Using OpenClaw or ClawHub? Install the packaged skill with:

```bash
clawhub install swarmvault
```

That installs the published `SKILL.md` plus a ClawHub README, examples, references, troubleshooting notes, and validation prompts. Keep the CLI itself updated with `npm install -g @swarmvaultai/cli@latest`.

<!-- readme-section:input-types -->
## Works With Any Mix Of Input Types

| Input | Extensions / Sources | Extraction |
|-------|---------------------|------------|
| Code | `.js .ts .py .go .rs .java .cs .c .cpp .php .rb .ps1 .kt .kts .scala .sc` | AST via tree-sitter + module resolution |
| PDF | `.pdf` | Local text extraction |
| DOCX | `.docx` | Local extraction with metadata |
| HTML | `.html`, URLs | Readability + Turndown to markdown |
| Images | `.png .jpg .webp` | Vision provider (when configured) |
| Research | arXiv, DOI, articles, X/Twitter | Normalized markdown via `swarmvault add` |
| Text docs | `.md .mdx .txt .rst .rest` | Direct ingest with lightweight `.rst` heading normalization |
| Browser clips | inbox bundles | Asset-rewritten markdown via `inbox import` |

<!-- readme-section:what-you-get -->
## What You Get

**Knowledge graph with provenance** - every edge traces back to a specific source and claim. Nodes carry freshness, confidence, and community membership.

**God nodes and communities** - highest-connectivity bridge nodes identified automatically. Graph report pages surface surprising connections with plain-English explanations.

**Contradiction detection** - conflicting claims across sources are detected automatically and surfaced in the graph report. Use `lint --conflicts` for a focused contradiction audit.

**Semantic auto-tagging** - broad domain tags are extracted alongside concepts during analysis and appear in page frontmatter, graph nodes, and search.

**Schema-guided compilation** - each vault carries `swarmvault.schema.md` so the compiler follows domain-specific naming rules, categories, and grounding requirements.

**Save-first queries** - answers write to `wiki/outputs/` by default, so useful work compounds instead of disappearing. Supports `markdown`, `report`, `slides`, `chart`, and `image` output formats.

**Reviewable changes** - `compile --approve` stages changes into approval bundles. New concepts and entities land in `wiki/candidates/` first. Nothing mutates silently.

**12+ LLM providers** - OpenAI, Anthropic, Gemini, Ollama, OpenRouter, Groq, Together, xAI, Cerebras, generic OpenAI-compatible, custom adapters, or the built-in heuristic for offline use.

**9 agent integrations** - install rules for Codex, Claude Code, Cursor, Goose, Pi, Gemini CLI, OpenCode, Aider, and GitHub Copilot CLI. Optional graph-first hooks bias agents toward the wiki before broad search.

**MCP server** - `swarmvault mcp` exposes the vault to any compatible agent client over stdio.

**Automation** - watch mode, git hooks, recurring schedules, and inbox import keep the vault current without manual intervention.

**External graph sinks** - export to HTML, SVG, GraphML, and Cypher, or push the live graph directly into Neo4j over Bolt/Aura with shared-database-safe `vaultId` namespacing.

**Large-repo hardening** - long repo ingests and compile passes emit bounded progress on big batches, parser compatibility failures stay local to the affected sources with explicit diagnostics, and graph reports roll up tiny fragmented communities for readability.

Every edge is tagged `extracted`, `inferred`, or `ambiguous` - you always know what was found vs guessed.

<!-- readme-section:platform-support -->
## Platform Support

| Agent | Install command |
|-------|----------------|
| Codex | `swarmvault install --agent codex` |
| Claude Code | `swarmvault install --agent claude` |
| Cursor | `swarmvault install --agent cursor` |
| Goose | `swarmvault install --agent goose` |
| Pi | `swarmvault install --agent pi` |
| Gemini CLI | `swarmvault install --agent gemini` |
| OpenCode | `swarmvault install --agent opencode` |
| Aider | `swarmvault install --agent aider` |
| GitHub Copilot CLI | `swarmvault install --agent copilot` |

Claude Code, OpenCode, Gemini CLI, and Copilot also support `--hook` for graph-first context injection.

<!-- readme-section:worked-examples -->
## Worked Examples

| Example | Focus | Source |
|---------|-------|--------|
| code-repo | Repo ingest, module pages, graph reports, benchmarks | [`worked/code-repo/`](worked/code-repo/) |
| capture | Research-aware `add` capture with normalized metadata | [`worked/capture/`](worked/capture/) |
| mixed-corpus | Compile, review, save-first output loops | [`worked/mixed-corpus/`](worked/mixed-corpus/) |

Each folder has real input files and actual output so you can run it yourself and verify. See the [examples guide](https://www.swarmvault.ai/docs/getting-started/examples) for step-by-step walkthroughs.

<!-- readme-section:providers -->
## Providers

SwarmVault routes by capability, not brand. Built-in provider types:

`heuristic` `openai` `anthropic` `gemini` `ollama` `openrouter` `groq` `together` `xai` `cerebras` `openai-compatible` `custom`

See the [provider docs](https://www.swarmvault.ai/docs/providers) for configuration examples.

<!-- readme-section:packages -->
## Packages

| Package | Purpose |
|---------|---------|
| `@swarmvaultai/cli` | Global CLI (`swarmvault` and `vault` commands) |
| `@swarmvaultai/engine` | Runtime library for ingest, compile, query, lint, watch, MCP |
| `@swarmvaultai/viewer` | Graph viewer (included in CLI, no separate install needed) |

<!-- readme-section:help -->
## Need Help?

- Docs: https://www.swarmvault.ai/docs
- Providers: https://www.swarmvault.ai/docs/providers
- Troubleshooting: https://www.swarmvault.ai/docs/getting-started/troubleshooting
- npm package: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub issues: https://github.com/swarmclawai/swarmvault/issues

<!-- readme-section:development -->
## Development

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for PR guidelines, and [docs/live-testing.md](docs/live-testing.md) for the published-package validation workflow.

<!-- readme-section:links -->
## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault

<!-- readme-section:license -->
## License

MIT
