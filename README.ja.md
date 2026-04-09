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

SwarmVault は Andrej Karpathy の [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) gist に着想を得ています。核になる発想は同じで、生のソースと日々の利用の間に永続的な wiki を置くことです。SwarmVault はそのパターンを、グラフ、検索、レビュー、オートメーション、そして任意のモデル強化を備えたローカルなツールチェーンとして具体化しています。

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
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://example.com/docs/getting-started
swarmvault ingest ./src --repo-root .
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault compile
swarmvault query "What is the auth flow?"
swarmvault graph serve
swarmvault graph push neo4j --dry-run
```

とても大きなグラフでは、`swarmvault graph serve` と `swarmvault graph export --html` は自動で overview mode で始まります。全面表示したい場合は `--full` を付けてください。

<!-- readme-section:provider-setup -->
## 任意: モデルプロバイダーを追加

SwarmVault を始めるのに API キーや外部モデルプロバイダーは必須ではありません。組み込みの `heuristic` プロバイダーで、ローカル/オフラインのボルト初期化、ingest、compile、graph/report/search、軽量な query や lint の既定フローを回せます。

より高品質な統合結果や、semantic embeddings、vision、ネイティブ画像生成のような追加機能が欲しいときに、モデルプロバイダーを追加してください:

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

他の任意バックエンド、タスクの振り分け、能力ごとの設定例は [provider docs](https://www.swarmvault.ai/docs/providers) を参照してください。

API キーなしでローカルの semantic graph query を使いたい場合は、`heuristic` ではなく、Ollama のような embeddings 対応ローカルバックエンドを使ってください:

```json
{
  "providers": {
    "local": {
      "type": "heuristic",
      "model": "heuristic-v1"
    },
    "ollama-embeddings": {
      "type": "ollama",
      "model": "nomic-embed-text",
      "baseUrl": "http://localhost:11434/v1"
    }
  },
  "tasks": {
    "compileProvider": "local",
    "queryProvider": "local",
    "embeddingProvider": "ollama-embeddings"
  }
}
```

## リポジトリや docs ハブを直接追加

SwarmVault をすぐ役立てる最短経路は、managed-source ワークフローです:

```bash
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://example.com/docs/getting-started
swarmvault source list
swarmvault source reload --all
```

`source add` はソースを登録し、ボルトへ同期し、1 回 compile し、`wiki/outputs/source-briefs/` にソース別ブリーフを書きます。単発のファイルや URL には `ingest`、研究 URL の正規化には `add` を使ってください。

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

OpenClaw または ClawHub を使う場合は、パッケージ済みのスキルを次で導入できます:

```bash
clawhub install swarmvault
```

これで公開済みの `SKILL.md` に加えて、ClawHub 用 README、例、リファレンス、トラブルシューティング、検証用プロンプトが入ります。CLI 自体の更新は `npm install -g @swarmvaultai/cli@latest` を使います。

<!-- readme-section:input-types -->
## さまざまな入力を混在して扱えます

| Input | 拡張子 / ソース | 抽出方法 |
|-------|-----------------|----------|
| PDF | `.pdf` | ローカルでテキスト抽出 |
| DOCX | `.docx` | ローカル抽出とメタデータ取得 |
| EPUB 書籍 | `.epub` | ローカルで章ごとに分割し Markdown 化 |
| データセット | `.csv .tsv` | ローカルで表形式サマリーと限定プレビューを生成 |
| スプレッドシート | `.xlsx` | ローカルでブックとシートのプレビューを抽出 |
| スライド | `.pptx` | ローカルでスライド本文とノートを抽出 |
| HTML | `.html`, URLs | Readability + Turndown による Markdown 化 |
| Images | `.png .jpg .webp` | Vision provider（設定されている場合） |
| Research | arXiv, DOI, articles, X/Twitter | `swarmvault add` による正規化 Markdown |
| Text docs | `.md .mdx .txt .rst .rest` | 直接 ingest と軽量な `.rst` 見出し正規化 |
| Code | `.js .jsx .ts .tsx .py .go .rs .java .kt .kts .scala .sc .lua .zig .cs .c .cpp .php .rb .ps1` | tree-sitter ベースの AST とモジュール解決 |
| Browser clips | inbox bundles | `inbox import` によるアセット書き換え済み Markdown |
| Managed sources | ローカルディレクトリ、公開 GitHub リポジトリ root URL、docs ハブ URL | `swarmvault source add` によるレジストリ同期 |

<!-- readme-section:what-you-get -->
## 得られるもの

**出典付きのナレッジグラフ** - すべてのエッジが特定のソースと特定の主張へ追跡できます。ノードは freshness、confidence、community membership を持ちます。

**God nodes とコミュニティ** - 接続度の高い橋渡しノードを自動検出します。グラフレポートページでは「なぜこのつながりが重要か」を平易な言葉で示します。

**schema-guided compilation** - 各ボルトは `swarmvault.schema.md` を持ち、コンパイラはドメイン固有の命名規則、分類、grounding 要件に従います。

**save-first query** - 回答は既定で `wiki/outputs/` に書き込まれるため、有用な作業が消えずに蓄積されます。`markdown`、`report`、`slides`、`chart`、`image` に対応します。

**レビュー可能な変更** - `compile --approve` は変更を approval bundles として段階化します。新しい concepts と entities はまず `wiki/candidates/` に入るため、黙って変更されません。

**任意のモデルプロバイダー** - OpenAI、Anthropic、Gemini、Ollama、OpenRouter、Groq、Together、xAI、Cerebras、汎用 OpenAI-compatible、custom adapters、そしてオフライン/ローカル既定の heuristic を使えます。

**9 つの agent integration** - Codex、Claude Code、Cursor、Goose、Pi、Gemini CLI、OpenCode、Aider、GitHub Copilot CLI 用のインストール規則があります。任意の graph-first hooks により、エージェントは広い検索の前に wiki を優先します。

**MCP server** - `swarmvault mcp` はボルトを stdio 経由で互換エージェントクライアントへ公開します。

**Automation** - watch mode、git hooks、定期実行、inbox import により、ボルトを手動更新なしで最新に保てます。

**Managed sources** - `swarmvault source add|list|reload|delete` により、繰り返し使うディレクトリ、公開 GitHub リポジトリ、docs サイトを名前付き同期ソースとして管理できます。レジストリは `state/sources.json`、ソース別ブリーフは `wiki/outputs/source-briefs/` に保存されます。

**外部グラフ連携** - HTML、SVG、GraphML、Cypher にエクスポートでき、Bolt/Aura 経由で Neo4j へライブグラフを直接 push することもできます。共有 DB 上でも `vaultId` により安全に名前空間分離されます。

**大規模リポジトリ向けの堅牢化** - 大きな repo ingest や compile では抑制された進捗表示を出し、parser 互換性の失敗は該当ソースだけに閉じ込めて明示的な診断を残し、グラフレポートでは細かすぎるコミュニティをまとめて可読性を保ちます。

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

モデルプロバイダーは任意です。SwarmVault はブランド名ではなく能力でルーティングします。組み込みの provider type:

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
