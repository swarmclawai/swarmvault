# SwarmVault

<!-- readme-language-nav:start -->
**Languages:** [English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)
<!-- readme-language-nav:end -->

[![npm](https://img.shields.io/npm/v/@swarmvaultai/cli)](https://www.npmjs.com/package/@swarmvaultai/cli)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)]()

**AI エージェント向けのローカルファーストな知識コンパイラ。** 生のファイル、URL、コードを永続的な知識ボルトへ変換します。作業をチャット履歴の中で失うのではなく、Markdown wiki、ナレッジグラフ、ローカル検索、レビュー可能な成果物としてディスクに残せます。

ウェブサイトのドキュメントは現在 English-first です。各言語版で表現に差が出た場合は [README.md](README.md) を正としてください。

> 多くの「ドキュメントと会話する」ツールは、質問に答えたあと作業を捨ててしまいます。SwarmVault はボルトそのものをプロダクトとして扱います。すべての操作が、確認・差分比較・継続改善できる永続的な成果物を書き出します。

<!-- readme-section:install -->
## インストール

SwarmVault には Node `>=24` が必要です。

```bash
npm install -g @swarmvaultai/cli
```

インストール確認:

```bash
swarmvault --version
```

最新の公開版へ更新:

```bash
npm install -g @swarmvaultai/cli@latest
```

グローバル CLI にはグラフビューアのワークフローと MCP サーバーフローがすでに含まれています。通常の利用では `@swarmvaultai/viewer` を別途インストールする必要はありません。

<!-- readme-section:quickstart -->
## クイックスタート

```text
my-vault/
├── swarmvault.schema.md       ユーザーが編集するボルト指示ファイル
├── raw/                       不変のソースファイルとローカライズ済みアセット
├── wiki/                      コンパイル済み wiki: sources, concepts, entities, code, outputs, graph
├── state/                     graph.json, search.sqlite, embeddings, sessions, approvals
├── .obsidian/                 任意の Obsidian ワークスペース設定
└── agent/                     エージェント向けに生成される補助ファイル
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
## 実運用プロバイダーの設定

組み込みの `heuristic` プロバイダーは smoke テストやオフライン既定値には便利ですが、本格的な要約や問い合わせ品質には向きません。実運用では、ボルトを実際のモデルプロバイダーに向けてください:

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

他のバックエンドや設定例は [provider docs](https://www.swarmvault.ai/docs/providers) を参照してください。

<!-- readme-section:agent-setup -->
## エージェントと MCP の設定

まず、コーディングエージェントにボルトのルールをインストールします:

```bash
swarmvault install --agent claude --hook    # Claude Code + graph-first hook
swarmvault install --agent codex            # Codex
swarmvault install --agent cursor           # Cursor
swarmvault install --agent copilot --hook   # GitHub Copilot CLI + hook
swarmvault install --agent gemini --hook    # Gemini CLI + hook
```

あるいは、ボルトを直接 MCP で公開します:

```bash
swarmvault mcp
```

<!-- readme-section:input-types -->
## さまざまな入力を混在して扱えます

| Input | 拡張子 / ソース | 抽出方法 |
|-------|-----------------|----------|
| Code | `.js .ts .py .go .rs .java .cs .c .cpp .php .rb .ps1` | tree-sitter ベースの AST とモジュール解決 |
| PDF | `.pdf` | ローカルでテキスト抽出 |
| DOCX | `.docx` | ローカル抽出とメタデータ取得 |
| HTML | `.html`, URLs | Readability + Turndown による Markdown 化 |
| Images | `.png .jpg .webp` | Vision provider（設定されている場合） |
| Research | arXiv, DOI, articles, X/Twitter | `swarmvault add` による正規化 Markdown |
| Markdown | `.md .txt` | 直接 ingest |
| Browser clips | inbox bundles | `inbox import` によるアセット書き換え済み Markdown |

<!-- readme-section:what-you-get -->
## 得られるもの

**出典付きのナレッジグラフ** - すべてのエッジが特定のソースと特定の主張へ追跡できます。ノードは freshness、confidence、community membership を持ちます。

**God nodes とコミュニティ** - 接続度の高い橋渡しノードを自動検出します。グラフレポートページでは「なぜこのつながりが重要か」を平易な言葉で示します。

**schema-guided compilation** - 各ボルトは `swarmvault.schema.md` を持ち、コンパイラはドメイン固有の命名規則、分類、grounding 要件に従います。

**save-first query** - 回答は既定で `wiki/outputs/` に書き込まれるため、有用な作業が消えずに蓄積されます。`markdown`、`report`、`slides`、`chart`、`image` に対応します。

**レビュー可能な変更** - `compile --approve` は変更を approval bundles として段階化します。新しい concepts と entities はまず `wiki/candidates/` に入るため、黙って変更されません。

**12+ LLM providers** - OpenAI、Anthropic、Gemini、Ollama、OpenRouter、Groq、Together、xAI、Cerebras、汎用 OpenAI-compatible、custom adapters、そしてオフライン既定の heuristic を使えます。

**9 つの agent integration** - Codex、Claude Code、Cursor、Goose、Pi、Gemini CLI、OpenCode、Aider、GitHub Copilot CLI 用のインストール規則があります。任意の graph-first hooks により、エージェントは広い検索の前に wiki を優先します。

**MCP server** - `swarmvault mcp` はボルトを stdio 経由で互換エージェントクライアントへ公開します。

**Automation** - watch mode、git hooks、定期実行、inbox import により、ボルトを手動更新なしで最新に保てます。

**外部グラフ連携** - HTML、SVG、GraphML、Cypher にエクスポートでき、Bolt/Aura 経由で Neo4j へライブグラフを直接 push することもできます。共有 DB 上でも `vaultId` により安全に名前空間分離されます。

各エッジには `extracted`、`inferred`、`ambiguous` のタグが付き、何が実際に見つかった情報で、何が推論かを常に判断できます。

<!-- readme-section:platform-support -->
## プラットフォーム対応

| Agent | インストールコマンド |
|-------|----------------------|
| Codex | `swarmvault install --agent codex` |
| Claude Code | `swarmvault install --agent claude` |
| Cursor | `swarmvault install --agent cursor` |
| Goose | `swarmvault install --agent goose` |
| Pi | `swarmvault install --agent pi` |
| Gemini CLI | `swarmvault install --agent gemini` |
| OpenCode | `swarmvault install --agent opencode` |
| Aider | `swarmvault install --agent aider` |
| GitHub Copilot CLI | `swarmvault install --agent copilot` |

Claude Code、OpenCode、Gemini CLI、Copilot は `--hook` にも対応しており、graph-first の文脈注入ができます。

<!-- readme-section:worked-examples -->
## 実例

| Example | 重点 | ソース |
|---------|------|--------|
| code-repo | repo ingest、module pages、graph reports、benchmarks | [`worked/code-repo/`](worked/code-repo/) |
| capture | 研究向け `add` capture と正規化メタデータ | [`worked/capture/`](worked/capture/) |
| mixed-corpus | compile、review、save-first output loops | [`worked/mixed-corpus/`](worked/mixed-corpus/) |

各フォルダには実際の入力ファイルと実際の出力が入っているので、そのまま実行して確認できます。手順付きの説明は [examples guide](https://www.swarmvault.ai/docs/getting-started/examples) を参照してください。

<!-- readme-section:providers -->
## Providers

SwarmVault はブランド名ではなく能力でルーティングします。組み込みの provider type:

`heuristic` `openai` `anthropic` `gemini` `ollama` `openrouter` `groq` `together` `xai` `cerebras` `openai-compatible` `custom`

設定例は [provider docs](https://www.swarmvault.ai/docs/providers) を参照してください。

<!-- readme-section:packages -->
## Packages

| Package | 目的 |
|---------|------|
| `@swarmvaultai/cli` | グローバル CLI（`swarmvault` と `vault` コマンド） |
| `@swarmvaultai/engine` | ingest、compile、query、lint、watch、MCP のランタイムライブラリ |
| `@swarmvaultai/viewer` | グラフビューア（CLI に含まれており別途インストール不要） |

<!-- readme-section:help -->
## ヘルプ

- Docs: https://www.swarmvault.ai/docs
- Providers: https://www.swarmvault.ai/docs/providers
- Troubleshooting: https://www.swarmvault.ai/docs/getting-started/troubleshooting
- npm package: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub issues: https://github.com/swarmclawai/swarmvault/issues

<!-- readme-section:development -->
## 開発

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

PR のガイドラインは [CONTRIBUTING.md](CONTRIBUTING.md)、公開パッケージの検証フローは [docs/live-testing.md](docs/live-testing.md) を参照してください。

<!-- readme-section:links -->
## リンク

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault

<!-- readme-section:license -->
## ライセンス

MIT
