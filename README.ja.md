# SwarmVault

<!-- readme-language-nav:start -->
**Languages:** [English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)
<!-- readme-language-nav:end -->

[![npm](https://img.shields.io/npm/v/@swarmvaultai/cli)](https://www.npmjs.com/package/@swarmvaultai/cli)
[![npm downloads](https://img.shields.io/npm/dw/@swarmvaultai/cli)](https://www.npmjs.com/package/@swarmvaultai/cli)
[![GitHub stars](https://img.shields.io/github/stars/swarmclawai/swarmvault)](https://github.com/swarmclawai/swarmvault)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)]()

**AI エージェント向けのローカルファーストな知識コンパイラ**、[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) パターンに基づいて構築。多くの「ドキュメントと会話する」ツールは、質問に答えたあと作業を捨ててしまいます。SwarmVault は生のソースとあなたの間に**永続的な wiki** を維持します —— LLM が記録整理を行い、あなたは思考に集中できます。

ウェブサイトのドキュメントは現在 English-first です。各言語版で表現に差が出た場合は [README.md](README.md) を正としてください。

<!-- readme-section:try-it -->
## 30 秒で試す

```bash
npm install -g @swarmvaultai/cli
swarmvault scan ./your-repo       # 自分のコードベースやドキュメントを指定
# → ナレッジグラフがブラウザで開きます
```

各 compile は、投稿、リンク共有、スクリーンショット向けの portable share kit も生成します：

```bash
swarmvault graph share --post
swarmvault graph share --svg ./share-card.svg
swarmvault graph share --bundle ./share-kit
swarmvault context build "Ship this feature safely" --target ./src
swarmvault task start "Ship this feature safely" --target ./src
swarmvault doctor
```

手元にリポジトリがない場合は、組み込みデモをお試しください —— 3 つのサンプルソースで vault を作成し、グラフビューアを開きます：

```bash
swarmvault demo
```

![SwarmVault graph workspace](https://www.swarmvault.ai/images/screenshots/graph-workspace.png)

この 1 コマンドで vault を初期化し、ソースを取り込み、ナレッジグラフをコンパイルし、インタラクティブビューアを開きます。API キー不要 —— 組み込みの heuristic provider は完全にオフラインで動作します。

**ディスク上に生成されるもの：**

- **ナレッジグラフ** —— 型付きノード（sources, concepts, entities, code modules）と出典追跡エッジ
- **検索可能な wiki ページ** —— ソース要約、コンセプトページ、エンティティページ、相互参照
- **矛盾検出** —— ソース間の相反する主張を自動フラグ
- **グラフレポート** —— サプライズスコアリング、god nodes、コミュニティ検出、平易な解説
- **Share kit** —— `wiki/graph/share-card.md`、`wiki/graph/share-card.svg`、`wiki/graph/share-kit/`、`swarmvault graph share --post`、`swarmvault graph share --svg`、`swarmvault graph share --bundle` によるコピー可能、視覚的、HTML preview 付きの初回サマリー
- **Context packs** —— 目的、対象、token 予算に合わせた agent-ready な evidence bundle を `wiki/context/` と `state/context-packs/` に保存
- **Agent task ledger** —— `swarmvault task start|update|finish|resume` がローカルで git-friendly な task history を `wiki/memory/` と `state/memory/` に保存します。`memory` は互換 alias として残ります
- **Vault doctor とワークベンチ** —— `swarmvault doctor [--repair]`、MCP `doctor_vault`、グラフビューアのワークベンチが graph、retrieval、review、watch、migration、managed sources、task state をまとめて確認し、優先度付き next action、詳細な checks、コピー可能なコマンド、安全な repair、明示的な capture mode、budget 付き agent handoff を表示します

### 三層アーキテクチャ

SwarmVault は Andrej Karpathy が提唱したパターンに従い、三つの層を用います：

1. **生のソース** (`raw/`) —— 厳選されたソースドキュメントのコレクション。書籍、記事、論文、書き起こし、コード、画像、データセット。これらは不変です：SwarmVault は読み取るだけで、変更しません。
2. **Wiki** (`wiki/`) —— LLM が生成し、人間が執筆する Markdown ファイル。ソース要約、エンティティページ、コンセプトページ、相互参照、ダッシュボード、出力。Wiki は持続的に蓄積される永続的な成果物です。
3. **スキーマ** (`swarmvault.schema.md`) —— wiki の構造、従うべき規約、およびあなたのドメインで何が重要かを定義します。あなたと LLM がこのファイルを共に進化させていきます。

> Vannevar Bush の Memex（1945年）の理念を受け継ぎ —— ドキュメント間の連想トレイルを持つ個人的で厳選された知識ストア —— SwarmVault はソース間のつながりをソースそのものと同じくらい重要に扱います。Bush が解決できなかったのは、誰がメンテナンスを行うかという問題でした。LLM がそれを解決します。

書籍、記事、ノート、書き起こし、メール書き出し、カレンダー、データセット、スライド、スクリーンショット、URL、コードを、ナレッジグラフ、ローカル検索、ダッシュボード、レビュー可能な成果物を含む永続的な知識ボルトに変換します。**個人知識管理**、**研究の深堀り**、**読書コンパニオン**、**コードドキュメンテーション**、**ビジネスインテリジェンス**、または長期にわたって知識を蓄積し整理したいあらゆる領域に利用できます。

SwarmVault は LLM Wiki パターンを、グラフナビゲーション、検索、レビュー、オートメーション、オプションのモデル強化を備えたローカルなツールチェーンに具体化しています。[スタンドアロンスキーマテンプレート](templates/llm-wiki-schema.md)から始めることもできます —— インストール不要、任意の LLM エージェントで —— 必要に応じてフル CLI にアップグレードできます。

<!-- readme-section:why -->
## なぜ SwarmVault なのか

Karpathy の [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) に共感したなら、SwarmVault はその本番グレード版です。コミュニティで最も多い懸念にどう対応しているかを紹介します：

**「ハルシネーションが蓄積しないか？」** —— すべてのエッジに `extracted`、`inferred`、`ambiguous` のタグが付きます。矛盾検出が相反する主張をフラグします。`compile --approve` ですべての変更をレビュー可能な approval bundle に段階化。新しいコンセプトはまず `wiki/candidates/` に入ります。`lint --conflicts` でオンデマンドの矛盾監査ができます。

**「100 ページ以上にスケールするか？」** —— はい。ハイブリッド検索が SQLite 全文検索とセマンティック embeddings を統合するため、すべてのページをコンテキストに入れる必要がありません。`compile --max-tokens` で出力を制限できます。グラフナビゲーション（`graph query`、`graph path`、`graph explain`）で検索ではなくトラバースが可能です。

**「個人利用だけ？」** —— Git ワークフロー（`--commit`）、watch モード＋git hooks、スケジュール自動化、MCP server でチーム利用も可能です。16 種のエージェント統合があります。

**「API キーは必要？」** —— 不要です。組み込み `heuristic` provider は完全にオフラインです。より高品質な抽出には [Ollama](https://ollama.com) と無料のローカル LLM を組み合わせられます。クラウド provider はオプションです。

<!-- readme-section:comparison -->
## Gist からプロダクションへ

| | Karpathy Gist | **SwarmVault** |
|---|:---:|:---:|
| 三層アーキテクチャ | 記述 | **実装済み** |
| Ingest / query / lint | 手動 | **CLI コマンド** |
| 1 コマンドで起動 | — | **`swarmvault scan`** |
| 型付きナレッジグラフ | — | **あり** |
| インタラクティブグラフビューア | — | **あり** |
| ビジュアル + 投稿しやすい share kit | — | **あり** |
| agent-ready context packs | — | **あり** |
| agent memory ledger | — | **あり** |
| Vault doctor + workbench | — | **あり** |
| 30+ 入力フォーマット | — | **あり** |
| コード対応（tree-sitter AST） | — | **あり** |
| オフライン / API キー不要 | — | **あり** |
| 矛盾検出 | 言及 | **自動** |
| Approval キュー | — | **あり** |
| 16 種のエージェント統合 | — | **あり** |
| Neo4j / グラフエクスポート | — | **あり** |
| MCP server | — | **あり** |
| Watch モード + git hooks | — | **あり** |
| ハイブリッド検索 + rerank | index.md | **SQLite FTS + embeddings** |

<!-- readme-section:install -->
## インストール

### デスクトップアプリ（Node.js不要）

macOS、Windows、Linux用のデスクトップアプリをダウンロード——ランタイム内蔵:

**[デスクトップアプリをダウンロード](https://www.swarmvault.ai/download)** | [GitHub Releases](https://github.com/swarmclawai/swarmvault-desktop/releases)

### CLI

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
├── state/                     graph.json, retrieval/, embeddings, sessions, approvals
├── .obsidian/                 任意の Obsidian ワークスペース設定
└── agent/                     エージェント向けに生成される補助ファイル
```

```bash
# フルワークフロー — ステップバイステップ
swarmvault init --obsidian --profile personal-research
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://example.com/docs/getting-started
swarmvault ingest ./meeting.srt --guide
swarmvault ingest ./customer-call.mp3
swarmvault ingest https://www.youtube.com/watch?v=dQw4w9WgXcQ
swarmvault source session transcript-or-session-id
swarmvault ingest ./src --repo-root .
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault compile
swarmvault diff
swarmvault graph share --post
swarmvault graph share --svg ./share-card.svg
swarmvault graph share --bundle ./share-kit
swarmvault graph blast ./src/index.ts
swarmvault query "What is the auth flow?"
swarmvault context build "Implement the auth refactor" --target ./src --budget 8000
swarmvault task start "Implement the auth refactor" --target ./src --agent codex
swarmvault retrieval status
swarmvault doctor --repair
swarmvault graph serve
swarmvault graph export --report ./exports/report.html
swarmvault graph export --obsidian ./exports/graph-vault
swarmvault graph push neo4j --dry-run
```

ローカル repo や docs ツリーを最短で一度見たい場合は、`swarmvault scan ./path --no-serve` を使います。現在のディレクトリを vault として初期化し、そのディレクトリを取り込み、compile まで実行し、`--no-serve` ならグラフビューアは起動しません。`wiki/graph/share-card.md`、`wiki/graph/share-card.svg`、`wiki/graph/share-kit/` も残るため、`swarmvault graph share --post` で短い共有用サマリーを出力し、`swarmvault graph share --svg ./share-card.svg` でビジュアルカードを生成し、`swarmvault graph share --bundle ./share-kit` で markdown、投稿テキスト、SVG、自包含 HTML preview、JSON metadata を含む portable folder を作成できます。

`swarmvault context build "<goal>" --target <path-or-node> --budget <tokens>` は、次の agent 作業に必要なページ、ノード、エッジ、根拠を token 予算内にまとめます。出力形式は `--format markdown|json|llms` で選べ、保存済み bundle は `swarmvault context list` と `swarmvault context show <id>` で再利用できます。長めの作業では `swarmvault task start "<goal>" --target <path-or-node>` で永続 task ledger を作成し、`task update` で notes、decisions、changed paths、linked packs を記録し、`task resume <id>` で次の agent 向け handoff を出力します。既存の `memory` commands と `--memory <id>` flags は同じ task ledger の互換 alias として残ります。

agent に渡す前や viewer を開く前に素早く状態を見るには、`swarmvault doctor` を使います。graph、retrieval、review queue、watch status、migration state、managed sources、task ledger を確認し、`--repair` では安全に再生成できる retrieval artifacts を rebuild します。`swarmvault graph serve` のワークベンチは優先度付き next action、全 doctor check、詳細、コピー可能な推奨コマンドを表示し、安全な直接 repair、明示的な capture mode、title/tag capture fields、context-pack 作成、token budget 付き task-start actions を実行できます。

実データを入れる前にゼロ設定の体験をしたい場合は、`swarmvault demo --no-serve` も使えます。内蔵ソースを持つ一時的な sample vault を作成し、そのまま compile します。

とても大きなグラフでは、`swarmvault graph serve` と `swarmvault graph export --html` は自動で overview mode で始まります。全面表示したい場合は `--full` を付けてください。

vault が git リポジトリ内にある場合、`ingest`、`compile`、`query` は `--commit` も受け付け、生成された `wiki/` と `state/` の変更をすぐ commit できます。`compile --max-tokens <n>` は、コンテキスト窓を制約したいときに優先度の低いページを落として出力を抑えます。

`swarmvault init --profile` は `default`、`personal-research`、そして `reader,timeline` のようなカンマ区切り preset list を受け付けます。`personal-research` の preset は `profile.guidedIngestDefault` と `profile.deepLintDefault` を両方有効にするので、ingest/source と lint は `--no-guide` や `--no-deep` を付けない限り強いパスで始まります。独自のボルト挙動にしたい場合は `swarmvault.config.json` の `profile` ブロックを編集し、`swarmvault.schema.md` は人間が書く意図レイヤーとして使い続けてください。

<!-- readme-section:provider-setup -->
## 任意: モデルプロバイダーを追加

SwarmVault を始めるのに API キーや外部モデルプロバイダーは必須ではありません。組み込みの `heuristic` プロバイダーで、ローカル/オフラインのボルト初期化、ingest、compile、graph/report/search、軽量な query や lint の既定フローを回せます。

より高品質な統合結果や、semantic embeddings、vision、ネイティブ画像生成のような追加機能が欲しいときに、モデルプロバイダーを追加してください:

### 推奨: Ollama + Gemma によるローカル LLM

concept・entity・claim の抽出品質を高めたまま完全ローカルで動かしたい場合は、無料の [Ollama](https://ollama.com) ランタイムと Google の Gemma モデルを組み合わせるのがおすすめです。API キーは不要です。

```bash
ollama pull gemma4
```

```json
{
  "providers": {
    "llm": {
      "type": "ollama",
      "model": "gemma4",
      "baseUrl": "http://localhost:11434/v1"
    }
  },
  "tasks": {
    "compileProvider": "llm",
    "queryProvider": "llm",
    "lintProvider": "llm"
  }
}
```

heuristic プロバイダーのみの構成で compile/query を実行すると、SwarmVault はこの設定を勧める一回限りの通知を表示します。`SWARMVAULT_NO_NOTICES=1` を設定すると非表示にできます。サポートしている他のプロバイダー（OpenAI、Anthropic、Gemini、OpenRouter、Groq、Together、xAI、Cerebras、openai-compatible、custom）もそのまま使えます。

### ローカル Semantic Embeddings

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

embedding 対応 provider が利用できる場合、SwarmVault は既定で semantic page match もローカル search に統合します。`tasks.embeddingProvider` はその backend を明示的に選ぶ方法ですが、現在の `queryProvider` が embeddings をサポートしていればそちらに fallback することもあります。さらに `retrieval.rerank: true` を設定すると、現在の `queryProvider` が統合後の上位候補を再ランキングします。

### クラウド API プロバイダー

クラウドホスト型モデルを使用する場合は、API キーを含む provider ブロックを追加してください：

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

### 音声ファースト取り込み（ローカル Whisper）

ボイスメモ、会議録音、インタビューなどの音声は、whisper.cpp をインストールすれば SwarmVault がローカルで駆動します。API キー不要、ネットワーク通信もありません:

```bash
# macOS
brew install whisper-cpp
# Debian / Ubuntu
sudo apt install whisper.cpp

swarmvault provider setup --local-whisper --apply
```

このコマンドはバイナリを検出し、既定の `base.en` ggml モデル（約 147 MB）を `~/.swarmvault/models/` にダウンロードしたうえで、`swarmvault.config.json` の `providers.local-whisper` に provider を登録し、`tasks.audioProvider` をそこへ向けます。以降は `swarmvault add voice-memo.m4a`（または `raw/inbox/` に音声を置く）で完全オフラインのエンドツーエンド書き起こしが走り、既存の取り込み時 secret 除去は音声由来のテキストにも同じく適用されるため、会議中に口頭で出た鍵やトークンは `raw/` や `wiki/` に届く前にマスクされます。精度は `--model {tiny.en,small.en,medium.en,large-v3}`、スレッド数は `localWhisper.threads` で調整でき、バイナリ／モデルの探索は `localWhisper.binaryPath` / `localWhisper.modelPath` / `SWARMVAULT_WHISPER_BINARY` で上書きできます。`local-whisper` provider タイプは 1.1.0 では `STABILITY.md` 上 **experimental** 扱いです。

ホスト型の書き起こし provider を使いたい場合は、`tasks.audioProvider` を `audio` capability を持つ provider（OpenAI、Groq など）に向けてください。YouTube transcript 取り込みにはモデル provider は不要です。

## 継続的なソースをそのまま追加

SwarmVault をすぐ役立てる最短経路は、managed-source ワークフローです:

```bash
swarmvault source add ./exports/customer-call.srt --guide
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://example.com/docs/getting-started
swarmvault source list
swarmvault source session file-customer-call-srt-12345678
swarmvault source reload --all
```

`source add` はソースを登録し、ボルトへ同期し、1 回 compile し、`wiki/outputs/source-briefs/` にソース別ブリーフを書きます。`--guide` を付けると、`wiki/outputs/source-sessions/` に再開可能なガイド付き session を作成し、`profile.guidedSessionMode` が `canonical_review` のときは canonical な source/concept/entity page への更新を approval queue に段階化し、`insights_only` のときはガイド付き統合結果を `wiki/insights/` 側へ留めます。さらに `swarmvault.config.json` で `profile.guidedIngestDefault: true` を設定すれば、`ingest`、`source add`、`source reload` でガイド付きモードを既定にでき、個別の実行だけ軽量パスにしたいときは `--no-guide` でオーバーライドできます。ディレクトリや公開リポジトリ、docs ハブだけでなく、継続的に同期したいローカルファイルにも使えます。単発のファイルや URL には `ingest`、研究 URL の正規化には `add` を使ってください。

<!-- readme-section:agent-setup -->
## エージェントと MCP の設定

まず、コーディングエージェントにボルトのルールをインストールします:

```bash
swarmvault install --agent claude --hook    # Claude Code + graph-first hook
swarmvault install --agent codex --hook     # Codex + graph-first hook
swarmvault install --agent cursor           # Cursor
swarmvault install --agent copilot --hook   # GitHub Copilot CLI + hook
swarmvault install --agent gemini --hook    # Gemini CLI + hook
swarmvault install --agent trae             # Trae
swarmvault install --agent claw             # Claw / OpenClaw skill target
swarmvault install --agent droid            # Droid / Factory rules target
swarmvault install --agent kiro             # Kiro IDE + 常時 steering
swarmvault install --agent hermes           # Hermes ユーザースコープ skill
swarmvault install --agent antigravity      # Google Antigravity ルール + /swarmvault ワークフロー
swarmvault install --agent vscode           # VS Code Copilot Chat chatmode
```

最小構成の LLM-Wiki スターターが欲しい場合は `swarmvault init --lite` を使ってください。`raw/`、`wiki/`、`wiki/index.md`、`wiki/log.md`、`swarmvault.schema.md` だけを作成し、設定ファイルや state、エージェントインストールは生成しません。エージェントが wiki を直接メンテナンスします。グラフ・検索・approval のフルツールチェーンが必要になったら後から `swarmvault init` でアップグレードできます。

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
| Word ドキュメント | `.docx .docm .dotx .dotm` | ローカル抽出とメタデータ取得（マクロ対応およびテンプレートも含む） |
| Rich Text | `.rtf` | パーサーベースの RTF テキスト抽出 |
| OpenDocument | `.odt .odp .ods` | ローカルでテキスト / スライド / シートを抽出 |
| EPUB 書籍 | `.epub` | ローカルで章ごとに分割し Markdown 化 |
| データセット | `.csv .tsv` | ローカルで表形式サマリーと限定プレビューを生成 |
| スプレッドシート | `.xlsx .xlsm .xlsb .xls .xltx .xltm` | ローカルでブックとシートのプレビューを抽出（モダン、マクロ対応、バイナリ、レガシー形式） |
| スライド | `.pptx .pptm .potx .potm` | ローカルでスライド本文とノートを抽出（マクロ対応およびテンプレートも含む） |
| Jupyter ノートブック | `.ipynb` | ローカルでセルと出力を抽出 |
| BibTeX ライブラリ | `.bib` | パーサーベースの引用エントリ抽出 |
| Org-mode | `.org` | AST ベースの見出し・リスト・ブロック抽出 |
| AsciiDoc | `.adoc .asciidoc` | Asciidoctor ベースのセクション・メタデータ抽出 |
| 書き起こし | `.srt .vtt` | タイムスタンプ付きのテキストをローカル抽出 |
| チャット書き出し | Slack export `.zip`、展開済み Slack export ディレクトリ | チャンネル/日付単位の会話をローカル抽出 |
| メール | `.eml .mbox` | 単一メール抽出と mailbox 展開 |
| カレンダー | `.ics` | `VEVENT` のローカル展開 |
| 音声 | `.mp3 .wav .m4a .aac .ogg .webm` とその他の `audio/*` ファイル | ローカル Whisper（`swarmvault provider setup --local-whisper`）、または `tasks.audioProvider` 経由の provider ベース書き起こし |
| HTML | `.html`, URLs | Readability + Turndown による Markdown 化（URL 取り込み） |
| YouTube URL | `youtube.com/watch`、`youtu.be`、`youtube.com/embed`、`youtube.com/shorts` | transcript を直接取得し、タイトルと動画メタデータも抽出 |
| Images | `.png .jpg .jpeg .gif .webp .bmp .tif .tiff .svg .ico .heic .heif .avif .jxl` | Vision provider（設定されている場合） |
| Research | arXiv, DOI, articles, X/Twitter | `swarmvault add` による正規化 Markdown |
| Text docs | `.md .mdx .txt .rst .rest` | 直接 ingest と軽量な `.rst` 見出し正規化 |
| 設定 / データ | `.json .jsonc .json5 .toml .yaml .yml .xml .ini .conf .cfg .properties .env` | key/value スキーマヒント付きの構造化プレビュー |
| 開発者マニフェスト | `package.json` `tsconfig.json` `Cargo.toml` `pyproject.toml` `go.mod` `go.sum` `Dockerfile` `Makefile` `LICENSE` `.gitignore` `.editorconfig` `.npmrc` など | コンテンツスニッフベースのテキスト ingest —— 一般的な開発設定ファイルが暗黙的に捨てられることはありません |
| Code | `.js .mjs .cjs .jsx .ts .mts .cts .tsx .sh .bash .zsh .py .go .rs .java .kt .kts .scala .sc .dart .lua .zig .cs .c .cc .cpp .cxx .h .hh .hpp .hxx .php .rb .ps1 .psm1 .psd1 .ex .exs .ml .mli .m .mm .res .resi .sol .vue .css .html .htm`、および `#!/usr/bin/env node\|python\|ruby\|bash\|zsh` shebang を持つ拡張子なしスクリプト | tree-sitter ベースの AST とモジュール解決（`tsconfig.json` パスエイリアス対応） |
| Browser clips | inbox bundles | `inbox import` によるアセット書き換え済み Markdown |
| Managed sources | ローカルディレクトリ、公開 GitHub リポジトリ root URL、docs ハブ URL | `swarmvault source add` によるレジストリ同期 |

<!-- readme-section:what-you-get -->
## 得られるもの

**出典付きのナレッジグラフ** - すべてのエッジが特定のソースと特定の主張へ追跡できます。ノードは freshness、confidence、community membership を持ちます。

**God nodes とコミュニティ** - 接続度の高い橋渡しノードを自動検出します。グラフレポートページでは「なぜこのつながりが重要か」を平易な言葉で示します。

**schema-guided compilation** - 各ボルトは `swarmvault.schema.md` を持ち、コンパイラはドメイン固有の命名規則、分類、grounding 要件に従います。

**save-first query** - 回答は既定で `wiki/outputs/` に書き込まれるため、有用な作業が消えずに蓄積されます。`markdown`、`report`、`slides`、`chart`、`image` に対応します。

**Agent context packs** - `swarmvault context build` は、目的、任意の対象、token 予算に合わせて関連ページ、グラフ evidence、明示的な omitted list をまとめ、`wiki/context/` と `state/context-packs/` に保存します。Markdown、JSON、`llms.txt` 風の出力で、そのまま agent kickoff や PR レビュー、handoff に使えます。

**Agent task ledger** - `swarmvault task start|update|finish|resume` は、task goal、linked context packs、decisions、graph evidence、touched paths、outcomes、follow-ups を git-friendly な JSON と Markdown として `state/memory/tasks/` と `wiki/memory/tasks/` に保存します。Compile は task と decision をグラフに含めます。既存の `memory` commands は互換 alias として残ります。

**Vault doctor とワークベンチ** - `swarmvault doctor [--repair]` は graph artifacts、retrieval、review queue、watch state、migration、managed sources、source/page counts、task state を確認します。グラフビューアのワークベンチは優先度付き next action、全 check と詳細、コピー可能な推奨コマンド、安全な repair、明示的な capture mode、title/tag capture fields、budget 付き context-pack 作成、task-start actions を表示します。

**レビュー可能な変更** - `compile --approve` は変更を approval bundles として段階化します。新しい concepts と entities はまず `wiki/candidates/` に入るため、黙って変更されません。

**設定可能な profile** - `swarmvault.config.json` の `profile.presets`、`profile.dashboardPack`、`profile.guidedSessionMode`、`profile.guidedIngestDefault`、`profile.deepLintDefault`、`profile.dataviewBlocks` を組み合わせて、自分向けの vault mode を作れます。`personal-research` はあくまで built-in preset alias です。

**ガイド付き session** - `ingest --guide`、`source add --guide`、`source reload --guide`、`source guide <id>`、`source session <id>` は再開可能な source session を作成し、`wiki/outputs/source-sessions/` に残しながら、source review、source guide、そして profile 設定に応じて canonical page あるいは `wiki/insights/` へ向かう更新案を受け入れ前に段階化します。`swarmvault.config.json` で `profile.guidedIngestDefault: true` を設定すると、ingest と source コマンドでガイド付きモードがデフォルトになります。`--no-guide` でオーバーライドできます。

**deep lint の既定値** - `swarmvault.config.json` で `profile.deepLintDefault: true` を設定すると、`swarmvault lint` は LLM ベースの advisory deep lint を既定で含むようになります。特定の実行だけ構造チェックに戻したい場合は `--no-deep` を使ってください。

**Web-search 強化 lint** — `lint --deep --web` は、設定済みの web-search provider（`http-json` または `custom`）を使用して deep-lint の検出結果に外部エビデンスを追加します。Web search は現在 deep lint のみに限定されています。他のコマンドはローカル vault 状態のみを参照します。

**知識ダッシュボード** - `wiki/dashboards/` には recent sources、reading log、timeline、source sessions、source guides、research map、contradictions、open questions が出力されます。まず plain markdown として読めることを優先し、`profile.dataviewBlocks` を有効にすると Obsidian Dataview 向けのクエリも追加されます。

**Retrieval、ハイブリッド search と rerank** - ローカル retrieval は SQLite FTS shard と manifest を `state/retrieval/` に保存します。embedding 対応 provider が利用できる場合、ローカル search は SQLite 全文検索と semantic page match を統合できます。`tasks.embeddingProvider` はその backend を明示的に選ぶ方法ですが、現在の `queryProvider` が embeddings をサポートしていればそちらに fallback することもあります。`retrieval.rerank: true` を使うと、`query` の前に現在の `queryProvider` が上位候補を再ランキングします。`swarmvault retrieval status|rebuild|doctor` で index を確認または修復できます。

**token 予算つき compile と自動 commit** - `compile --max-tokens <n>` は低優先度ページを削って生成 wiki を所定の token 予算内に収めます。`ingest|compile|query --commit` は、vault が git リポジトリ内にあるとき `wiki/` と `state/` の変更を即座に commit できます。

**グラフ健全性シグナル** - graph report artifact には community cohesion の要約、孤立ノードや曖昧 edge の warning、そして弱いまたは曖昧な領域を補う follow-up question も含まれるようになりました。

**ビジュアル + 投稿しやすい share kit** - すべての compile が `wiki/graph/share-card.md`、`wiki/graph/share-card.svg`、`wiki/graph/share-kit/` を生成します。`swarmvault graph share --post` は短いテキストを出力し、`swarmvault graph share --svg [path]` は 1200x630 のビジュアルカードを書き出し、`swarmvault graph share --bundle [dir]` は markdown、投稿テキスト、SVG、HTML preview、JSON metadata を書き出して、投稿、リンク共有、スクリーンショットに使いやすくします。

**graph blast radius、refresh、report export** - `graph blast <target>` は module dependency の reverse import をたどって変更影響範囲を示し、`graph update [path]` / `graph refresh [path]` は graph artifacts 向けに code-only repo refresh cycle を実行し、`graph export --report` は統計、主要ノード、コミュニティ、warning を含む self-contained HTML report を出力します。

**グラフ diff** - `swarmvault diff` は現在のナレッジグラフを最後にコミットされたバージョンと比較し、追加/削除されたノード、エッジ、ページを表示して、compile で何が変わったかを正確に確認できます。

**Obsidian グラフ export** - `graph export --obsidian` は、既存 wiki フォルダ構成を保ちつつ、Breadcrumbs/Juggl 対応の型付きリンク frontmatter 付きグラフ接続、community note、orphan node stub、Dataview ダッシュボードページ、コピー済みアセット、`types.json`・ノードタイプ別カラーグループ・`cssclasses` を含む完全な `.obsidian` 設定を含む Obsidian 向け note bundle を書き出します。

**適応的なコミュニティ分割** - SwarmVault は小規模または疎なグラフでは Louvain の community resolution を自動調整します。クラスタリング結果を固定したい場合は `swarmvault.config.json` で `graph.communityResolution` を設定してください。

**任意のモデルプロバイダー** - OpenAI、Anthropic、Gemini、Ollama、OpenRouter、Groq、Together、xAI、Cerebras、汎用 OpenAI-compatible、custom adapters、そしてオフライン/ローカル既定の heuristic を使えます。

**16 つの agent integration** - Codex、Claude Code、Cursor、Goose、Pi、Gemini CLI、OpenCode、Aider、GitHub Copilot CLI、Trae、Claw/OpenClaw、Droid、Kiro、Hermes、Google Antigravity、VS Code Copilot Chat 用のインストール規則があります。任意の graph-first hooks により、Codex を含む対応エージェントは広い検索の前に wiki を優先します。

**MCP server** - `swarmvault mcp` は graph stats、community lookup、hyperedges、context-pack、task-ledger、互換 memory-task、vault doctor、retrieval health tools を含むボルト操作を stdio 経由で互換エージェントクライアントへ公開します。

**組み込みブラウザ clipper** - `graph serve` はローカルの `/api/bookmarklet` ページと `/api/clip` エンドポイントを公開し、workbench または bookmarklet から現在のブラウザ URL、ページタイトル、選択テキスト、Markdown、HTML excerpt、tags を実行中の vault に取り込めます。URL-only bookmarklet clip は normalized `add` を使い、選択テキストは inbox import path で取り込みます。

**Automation** - watch mode、git hooks、定期実行、inbox import により、ボルトを手動更新なしで最新に保てます。

**Managed sources** - `swarmvault source add|list|reload|review|guide|session|delete` により、繰り返し使うローカルファイル、ディレクトリ、公開 GitHub リポジトリ、docs サイトを名前付き同期ソースとして管理できます。レジストリは `state/sources.json`、ソース別ブリーフは `wiki/outputs/source-briefs/`、再開可能な session アンカーは `wiki/outputs/source-sessions/`、ガイド付き統合成果物は `wiki/outputs/source-guides/` に保存されます。

**Source artifact の種類：**

| Artifact | 作成方法 | 用途 |
|----------|---------|------|
| Source brief | `source add`、`ingest`（常に作成） | 自動生成サマリー。`wiki/outputs/source-briefs/` に出力 |
| Source review | `source review`、`source add --guide` | 軽量なステージド評価。`wiki/outputs/source-reviews/` に出力 |
| Source guide | `source guide`、`source add --guide` | approval-bundled 更新を伴うガイド付きウォークスルー。`wiki/outputs/source-guides/` に出力 |
| Source session | `source session`、`source add --guide` | 再開可能なワークフロー状態。`wiki/outputs/source-sessions/` と `state/source-sessions/` に保存 |

**外部グラフ連携** - 完全版 HTML、軽量 standalone HTML、self-contained report HTML、SVG、GraphML、Cypher、JSON、Obsidian note bundle、Obsidian canvas にエクスポートでき、Bolt/Aura 経由で Neo4j へライブグラフを直接 push することもできます。共有 DB 上でも `vaultId` により安全に名前空間分離されます。

**大規模リポジトリ向けの堅牢化** - 大きな repo ingest や compile では抑制された進捗表示を出し、parser 互換性の失敗は該当ソースだけに閉じ込めて明示的な診断を残し、code-only repo watch cycle は non-code re-analysis を飛ばし、グラフレポートでは細かすぎるコミュニティをまとめて可読性を保ちます。

各エッジには `extracted`、`inferred`、`ambiguous` のタグが付き、何が実際に見つかった情報で、何が推論かを常に判断できます。

<!-- readme-section:platform-support -->
## プラットフォーム対応

| Agent | インストールコマンド |
|-------|----------------------|
| Codex | `swarmvault install --agent codex --hook` |
| Claude Code | `swarmvault install --agent claude` |
| Cursor | `swarmvault install --agent cursor` |
| Goose | `swarmvault install --agent goose` |
| Pi | `swarmvault install --agent pi` |
| Gemini CLI | `swarmvault install --agent gemini` |
| OpenCode | `swarmvault install --agent opencode` |
| Aider | `swarmvault install --agent aider` |
| GitHub Copilot CLI | `swarmvault install --agent copilot` |
| Trae | `swarmvault install --agent trae` |
| Claw / OpenClaw | `swarmvault install --agent claw` |
| Droid | `swarmvault install --agent droid` |
| Kiro | `swarmvault install --agent kiro` |
| Hermes | `swarmvault install --agent hermes` |
| Google Antigravity | `swarmvault install --agent antigravity` |
| VS Code Copilot Chat | `swarmvault install --agent vscode` |
| Amp | `swarmvault install --agent amp` |
| Augment | `swarmvault install --agent augment` |
| AdaL | `swarmvault install --agent adal` |
| IBM Bob | `swarmvault install --agent bob` |
| Cline | `swarmvault install --agent cline` |
| CodeBuddy | `swarmvault install --agent codebuddy` |
| Command Code | `swarmvault install --agent command-code` |
| Continue | `swarmvault install --agent continue` |
| Cortex Code | `swarmvault install --agent cortex` |
| Crush | `swarmvault install --agent crush` |
| Deep Agents | `swarmvault install --agent deepagents` |
| Firebender | `swarmvault install --agent firebender` |
| iFlow CLI | `swarmvault install --agent iflow` |
| Junie | `swarmvault install --agent junie` |
| Kilo Code | `swarmvault install --agent kilo-code` |
| Kimi Code CLI | `swarmvault install --agent kimi` |
| Kode | `swarmvault install --agent kode` |
| MCPJam | `swarmvault install --agent mcpjam` |
| Mistral Vibe | `swarmvault install --agent mistral-vibe` |
| Mux | `swarmvault install --agent mux` |
| Neovate | `swarmvault install --agent neovate` |
| OpenClaw | `swarmvault install --agent openclaw` |
| OpenHands | `swarmvault install --agent openhands` |
| Pochi | `swarmvault install --agent pochi` |
| Qoder | `swarmvault install --agent qoder` |
| Qwen Code | `swarmvault install --agent qwen-code` |
| Replit | `swarmvault install --agent replit` |
| Roo Code | `swarmvault install --agent roo-code` |
| TRAE CN | `swarmvault install --agent trae-cn` |
| Warp | `swarmvault install --agent warp` |
| Windsurf | `swarmvault install --agent windsurf` |
| Zencoder | `swarmvault install --agent zencoder` |

Codex、Claude Code、OpenCode、Gemini CLI、Copilot は `--hook` にも対応しており、graph-first の文脈注入ができます。拡張ロスターのエージェントは、対象ツールが規定する skills ディレクトリにプロジェクト単位の skill バンドルを書き込みます（例: `.cline/skills/swarmvault/SKILL.md`、`.codeium/windsurf/skills/swarmvault/SKILL.md`）。

<!-- readme-section:worked-examples -->
## 実例

各フォルダには実際の入力ファイルと実際の出力が入っているので、そのまま実行して確認できます。

| 実例 | 内容 | ソース |
|------|------|--------|
| **[research-deep-dive](worked/research-deep-dive/)** | 論文と記事で、ソース間の矛盾検出付き進化するテーゼを構築 | `worked/research-deep-dive/` |
| **[personal-knowledge-base](worked/personal-knowledge-base/)** | 日記、健康ノート、ポッドキャストをダッシュボード付きパーソナル Memex に | `worked/personal-knowledge-base/` |
| **[book-reading](worked/book-reading/)** | 章ごとに読みながらキャラクターとテーマのファン wiki を構築、読むほど蓄積 | `worked/book-reading/` |
| **[code-repo](worked/code-repo/)** | repo ingest、module pages、graph reports、benchmarks | `worked/code-repo/` |
| **[capture](worked/capture/)** | arXiv、DOI、URL からの研究向け `add` capture と正規化メタデータ | `worked/capture/` |
| **[mixed-corpus](worked/mixed-corpus/)** | compile、review、save-first output loops（混合入力タイプ） | `worked/mixed-corpus/` |

手順付きの説明は [examples guide](https://www.swarmvault.ai/docs/getting-started/examples) を参照してください。

<!-- readme-section:providers -->
## Providers

モデルプロバイダーは任意です。SwarmVault はブランド名ではなく能力でルーティングします。組み込みの provider type:

`heuristic` `openai` `anthropic` `gemini` `ollama` `openrouter` `groq` `together` `xai` `cerebras` `openai-compatible` `custom`

設定例は [provider docs](https://www.swarmvault.ai/docs/providers) を参照してください。

<!-- readme-section:privacy -->
## プライバシーとデータフロー

SwarmVault はデフォルトでデータをローカル処理します：

- **コードファイル** は tree-sitter によりローカルで解析されます。ソースコードの内容が外部 API に送信されることはありません。
- **ドキュメントとテキスト** はセマンティック抽出のために設定されたプロバイダーに送信されます。組み込みの `heuristic` プロバイダーを使用すれば、すべてローカルで完結します。
- **画像** はビジョン対応プロバイダーが設定されている場合のみ送信されます。
- **Heuristic モード**（デフォルト）は完全にオフラインで動作します — API キー不要、ネットワーク接続不要。

モデルプロバイダー（OpenAI、Anthropic、Ollama など）を追加すると、コード以外のコンテンツのみが LLM 分析に送信されます。グラフ構築、コミュニティ検出、レポート生成はすべてローカルで行われます。

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

公開 API コントラクト、semver の約束、廃止ポリシーは [STABILITY.md](STABILITY.md) を参照してください。1.0.0 リリース後、Stable な面はセマンティックバージョニングに従い、Experimental な面はマイナーリリースで変更される可能性があります。

テスト済みの動作規模、各階層のパフォーマンス境界、調整可能なノブは [SCALE.md](SCALE.md) を参照してください。1.0 の PDF 抽出戦略と既知の制限は [docs/pdf-extraction.md](docs/pdf-extraction.md) を参照してください。

<!-- readme-section:links -->
## リンク

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault

<!-- readme-section:license -->
## ライセンス

MIT
