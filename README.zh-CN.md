# SwarmVault

<!-- readme-language-nav:start -->
**语言:** [English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)
<!-- readme-language-nav:end -->

[![npm](https://img.shields.io/npm/v/@swarmvaultai/cli)](https://www.npmjs.com/package/@swarmvaultai/cli)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)]()

**面向 AI 代理的本地优先知识编译器。** 把原始文件、URL、代码、转录稿、邮件导出、日历、数据集和文档编译成持久化知识库。你不再把工作丢在聊天记录里，而是得到可以长期保存在磁盘上的 Markdown wiki、知识图谱、本地搜索、仪表盘和可审查的工件。

网站文档目前仍以英文为主。如果不同语言版本之间的表述出现偏差，请以 [README.md](README.md) 为准。

> 大多数“和文档聊天”的工具只回答一次问题，然后把过程全部丢掉。SwarmVault 把知识库本身当作产品。每一步都会写出可保留、可检查、可 diff、可持续改进的持久化工件。

SwarmVault 的思路受到 Andrej Karpathy 的 [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) gist 启发。核心模式是一致的：在原始来源与日常使用之间维护一个持久化 wiki。SwarmVault 则把这个模式进一步做成了带有图谱、搜索、审查流、自动化，以及可选模型增强能力的本地工具链。

<!-- readme-section:install -->
## 安装

SwarmVault 需要 Node `>=24`。

```bash
npm install -g @swarmvaultai/cli
```

验证安装：

```bash
swarmvault --version
```

升级到最新已发布版本：

```bash
npm install -g @swarmvaultai/cli@latest
```

全局 CLI 已经包含图谱查看器工作流和 MCP 服务流。普通用户不需要单独安装 `@swarmvaultai/viewer`。

<!-- readme-section:quickstart -->
## 快速开始

```text
my-vault/
├── swarmvault.schema.md       用户可编辑的知识库说明
├── raw/                       不可变原始源文件与本地化资产
├── wiki/                      编译后的 wiki：sources、concepts、entities、code、outputs、graph
├── state/                     graph.json、search.sqlite、embeddings、sessions、approvals
├── .obsidian/                 可选的 Obsidian 工作区配置
└── agent/                     面向代理生成的辅助文件
```

![SwarmVault graph workspace](https://www.swarmvault.ai/images/screenshots/graph-workspace.png)

```bash
swarmvault init --obsidian --profile personal-research
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://example.com/docs/getting-started
swarmvault ingest ./meeting.srt --guide
swarmvault source session transcript-or-session-id
swarmvault ingest ./src --repo-root .
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault compile
swarmvault query "What is the auth flow?"
swarmvault graph serve
swarmvault graph push neo4j --dry-run
```

对于非常大的图，`swarmvault graph serve` 和 `swarmvault graph export --html` 会自动进入 overview mode。若你仍想强制渲染完整画布，请添加 `--full`。

`swarmvault init --profile` 支持 `default`、`personal-research`，也支持 `reader,timeline` 这种逗号分隔的 preset 组合。若要自定义知识库行为，请直接编辑 `swarmvault.config.json` 里的 `profile` 配置块，并把 `swarmvault.schema.md` 继续当作人工维护的意图层。

<!-- readme-section:provider-setup -->
## 可选：添加模型提供方

开始使用 SwarmVault 并不需要 API key，也不需要外部模型提供方。内置的 `heuristic` 提供方可以支持本地/离线的知识库初始化、ingest、compile、graph/report/search，以及轻量级的 query 和 lint 默认流程。

当你希望获得更强的综合质量，或者需要语义 embeddings、vision、原生图片生成等额外能力时，再接入模型提供方即可：

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

其他可选后端、任务路由方式与能力配置请参阅 [provider docs](https://www.swarmvault.ai/docs/providers)。

### 推荐：通过 Ollama + Gemma 在本地运行 LLM

如果你想要一个完全本地的环境，并获得高质量的 concept、entity 和 claim 提取，推荐搭配使用免费的 [Ollama](https://ollama.com) 运行时和 Google 的 Gemma 模型。不需要 API key。

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

当你只配置 heuristic provider 时，SwarmVault 在 compile/query 命令中会显示一次性提示指向此配置。设置 `SWARMVAULT_NO_NOTICES=1` 可以关闭该提示。任何其他已支持的 provider（OpenAI、Anthropic、Gemini、OpenRouter、Groq、Together、xAI、Cerebras、openai-compatible、custom）同样可用。

如果你想在不使用 API key 的情况下启用本地语义图查询，请使用具备 embeddings 能力的本地后端，例如 Ollama，而不是 `heuristic`：

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

## 直接指向可重复使用的来源

最容易感受到 SwarmVault 价值的方式，是使用 managed-source 工作流：

```bash
swarmvault source add ./exports/customer-call.srt --guide
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://example.com/docs/getting-started
swarmvault source list
swarmvault source session file-customer-call-srt-12345678
swarmvault source reload --all
```

`source add` 会注册来源、把内容同步进知识库、执行一次 compile，并在 `wiki/outputs/source-briefs/` 下写出该来源的简报。加入 `--guide` 后，会额外创建一个可恢复的引导式 session，写入 `wiki/outputs/source-sessions/`，并在 `profile.guidedSessionMode` 为 `canonical_review` 时通过 approval queue 阶段化对 canonical 页面（source/concept/entity）的更新；如果配置为 `insights_only`，则会把引导式整合内容保留在 `wiki/insights/` 中。它现在同样适用于可重复同步的本地文件，而不仅是目录、公开仓库或文档站点。`ingest` 仍适合单次文件或 URL，`add` 仍适合研究资料/文章的标准化采集。

<!-- readme-section:agent-setup -->
## Agent 与 MCP 设置

先把知识库规则安装到你的编码代理中：

```bash
swarmvault install --agent claude --hook    # Claude Code + graph-first hook
swarmvault install --agent codex            # Codex
swarmvault install --agent cursor           # Cursor
swarmvault install --agent copilot --hook   # GitHub Copilot CLI + hook
swarmvault install --agent gemini --hook    # Gemini CLI + hook
```

或者直接通过 MCP 暴露知识库：

```bash
swarmvault mcp
```

如果你在使用 OpenClaw 或 ClawHub，可以这样安装打包好的技能：

```bash
clawhub install swarmvault
```

这会安装已发布的 `SKILL.md`，以及 ClawHub README、示例、参考资料、故障排查说明和验证提示。CLI 仍然通过 `npm install -g @swarmvaultai/cli@latest` 更新。

<!-- readme-section:input-types -->
## 支持多种输入类型混合使用

| 输入 | 扩展名 / 来源 | 提取方式 |
|------|---------------|----------|
| PDF | `.pdf` | 本地文本提取 |
| Word 文档 | `.docx .docm .dotx .dotm` | 本地提取与元数据捕获（涵盖启用宏与模板变体） |
| Rich Text | `.rtf` | 基于解析器的 RTF 文本本地提取 |
| OpenDocument | `.odt .odp .ods` | 本地文本 / 幻灯片 / 工作表提取 |
| EPUB 电子书 | `.epub` | 本地按章节拆分并转换为 Markdown |
| 数据集 | `.csv .tsv` | 本地表格摘要与有限预览 |
| 电子表格 | `.xlsx .xlsm .xlsb .xls .xltx .xltm` | 本地工作簿与工作表预览提取（现代、宏启用、二进制、旧版格式） |
| 幻灯片 | `.pptx .pptm .potx .potm` | 本地提取幻灯片文本与备注（涵盖启用宏与模板变体） |
| Jupyter 笔记本 | `.ipynb` | 本地提取 cell 与输出 |
| BibTeX 文献库 | `.bib` | 基于解析器的引用条目提取 |
| Org-mode | `.org` | 基于 AST 的标题、列表与代码块提取 |
| AsciiDoc | `.adoc .asciidoc` | 基于 Asciidoctor 的章节与元数据提取 |
| 转录稿 | `.srt .vtt` | 本地提取带时间戳的转录文本 |
| 聊天导出 | Slack 导出 `.zip`、解压后的 Slack 导出目录 | 本地提取按频道/日期分组的对话 |
| 邮件 | `.eml .mbox` | 本地提取单封邮件并展开邮箱文件 |
| 日历 | `.ics` | 本地展开 `VEVENT` 事件 |
| HTML | `.html`、URL | Readability + Turndown 转 Markdown（URL 抓取） |
| Images | `.png .jpg .jpeg .gif .webp .bmp .tif .tiff .svg .ico .heic .heif .avif .jxl` | Vision provider（已配置时） |
| Research | arXiv、DOI、文章、X/Twitter | 通过 `swarmvault add` 标准化为 Markdown |
| Text docs | `.md .mdx .txt .rst .rest` | 直接 ingest，并对 `.rst` 做轻量标题归一化 |
| 配置 / 数据 | `.json .jsonc .json5 .toml .yaml .yml .xml .ini .conf .cfg .properties .env` | 结构化预览，带 key/value schema 提示 |
| 开发清单文件 | `package.json` `tsconfig.json` `Cargo.toml` `pyproject.toml` `go.mod` `go.sum` `Dockerfile` `Makefile` `LICENSE` `.gitignore` `.editorconfig` `.npmrc` 等 | 基于内容嗅探的文本 ingest —— 常见开发配置不会被静默丢弃 |
| Code | `.js .mjs .cjs .jsx .ts .mts .cts .tsx .sh .bash .zsh .py .go .rs .java .kt .kts .scala .sc .dart .lua .zig .cs .c .cc .cpp .cxx .h .hh .hpp .hxx .php .rb .ps1 .psm1 .psd1 .ex .exs .ml .mli .m .mm .res .resi .sol .vue .css .html .htm`，以及带有 `#!/usr/bin/env node\|python\|ruby\|bash\|zsh` shebang 的无扩展名脚本 | 基于 tree-sitter 的 AST 与模块解析 |
| Browser clips | inbox bundles | 通过 `inbox import` 重写资产路径后的 Markdown |
| Managed sources | 本地目录、公开 GitHub 仓库根 URL、文档中心 URL | 通过 `swarmvault source add` 的 registry 同步 |

<!-- readme-section:what-you-get -->
## 你能得到什么

**带来源依据的知识图谱** - 每条边都能追溯到具体来源与具体陈述。节点包含 freshness、confidence 和 community membership。

**God nodes 与社区分析** - 自动识别连接度最高的桥接节点。图谱报告页会用自然语言解释“为什么这个连接值得关注”。

**由 schema 驱动的编译** - 每个知识库都带有 `swarmvault.schema.md`，编译器会遵循其中定义的命名规则、分类方式与 grounding 要求。

**save-first 查询** - 默认把答案写入 `wiki/outputs/`，让有价值的工作不断积累而不是消失。支持 `markdown`、`report`、`slides`、`chart` 和 `image` 输出格式。

**可审查的变更流** - `compile --approve` 会把变更先写入 approval bundles。新概念和实体会先进入 `wiki/candidates/`，不会静默修改。

**可配置 profile** - 通过 `swarmvault.config.json` 中的 `profile.presets`、`profile.dashboardPack`、`profile.guidedSessionMode` 和 `profile.dataviewBlocks` 组合出自己的知识库模式，而不是等待新的硬编码产品模式。`personal-research` 只是一个起步别名。

**引导式 session** - `ingest --guide`、`source add --guide`、`source reload --guide`、`source guide <id>` 和 `source session <id>` 会创建可恢复的 source session，写入 `wiki/outputs/source-sessions/`，并在你接受之前阶段化 source review、source guide，以及基于 profile 配置流向 canonical 页面或 `wiki/insights/` 的更新提案。

**知识仪表盘** - `wiki/dashboards/` 会生成 recent sources、reading log、timeline、source sessions、source guides、research map、contradictions 和 open questions 页面。默认先保证普通 Markdown 可读；当 `profile.dataviewBlocks` 打开时，会额外附加适合 Obsidian Dataview 的查询块。

**可选模型提供方** - OpenAI、Anthropic、Gemini、Ollama、OpenRouter、Groq、Together、xAI、Cerebras、通用 OpenAI-compatible、自定义适配器，以及适合离线/本地默认流程的 heuristic。

**9 种 agent 集成** - 支持 Codex、Claude Code、Cursor、Goose、Pi、Gemini CLI、OpenCode、Aider 和 GitHub Copilot CLI。可选 graph-first hooks 会先引导代理读取 wiki，再进行大范围搜索。

**MCP server** - `swarmvault mcp` 通过 stdio 把知识库暴露给任意兼容的代理客户端。

**自动化** - watch 模式、git hooks、定时任务和 inbox import 让知识库持续保持最新状态。

**托管来源** - `swarmvault source add|list|reload|review|guide|session|delete` 可以把重复使用的本地文件、目录、公开 GitHub 仓库和文档站点变成有名字的同步来源，注册表保存在 `state/sources.json`，来源简报写入 `wiki/outputs/source-briefs/`，可恢复的 session 锚点写入 `wiki/outputs/source-sessions/`，引导式整合产物写入 `wiki/outputs/source-guides/`。

**外部图谱输出** - 可导出为 HTML、SVG、GraphML、Cypher，也可以通过 Bolt/Aura 直接把实时图谱推送到 Neo4j，并用共享数据库安全的 `vaultId` 进行命名空间隔离。

**大型仓库加固** - 面对大批量仓库 ingest 和 compile 时会输出有边界的进度提示；parser 兼容性失败只会影响对应源文件并留下明确诊断；图谱报告会把过于碎片化的小社区折叠展示，保持可读性。

每条边都会标记为 `extracted`、`inferred` 或 `ambiguous`，因此你始终知道哪些是明确提取到的，哪些只是推断。

<!-- readme-section:platform-support -->
## 平台支持

| Agent | 安装命令 |
|-------|----------|
| Codex | `swarmvault install --agent codex` |
| Claude Code | `swarmvault install --agent claude` |
| Cursor | `swarmvault install --agent cursor` |
| Goose | `swarmvault install --agent goose` |
| Pi | `swarmvault install --agent pi` |
| Gemini CLI | `swarmvault install --agent gemini` |
| OpenCode | `swarmvault install --agent opencode` |
| Aider | `swarmvault install --agent aider` |
| GitHub Copilot CLI | `swarmvault install --agent copilot` |

Claude Code、OpenCode、Gemini CLI 和 Copilot 还支持 `--hook`，用于 graph-first 上下文注入。

<!-- readme-section:worked-examples -->
## 示例项目

| 示例 | 重点 | 来源 |
|------|------|------|
| code-repo | 仓库 ingest、模块页、图谱报告、benchmark | [`worked/code-repo/`](worked/code-repo/) |
| capture | 面向研究资料的 `add` 捕获与标准化元数据 | [`worked/capture/`](worked/capture/) |
| mixed-corpus | compile、review、save-first 输出循环 | [`worked/mixed-corpus/`](worked/mixed-corpus/) |

每个目录都包含真实输入文件和实际输出结果，你可以直接运行验证。分步演示见 [examples guide](https://www.swarmvault.ai/docs/getting-started/examples)。

<!-- readme-section:providers -->
## Providers

模型提供方是可选的。SwarmVault 按能力而不是按品牌路由。内置 provider 类型：

`heuristic` `openai` `anthropic` `gemini` `ollama` `openrouter` `groq` `together` `xai` `cerebras` `openai-compatible` `custom`

配置示例见 [provider docs](https://www.swarmvault.ai/docs/providers)。

<!-- readme-section:packages -->
## Packages

| Package | 用途 |
|---------|------|
| `@swarmvaultai/cli` | 全局 CLI（`swarmvault` 与 `vault` 命令） |
| `@swarmvaultai/engine` | ingest、compile、query、lint、watch、MCP 的运行时库 |
| `@swarmvaultai/viewer` | 图谱查看器（已包含在 CLI 中，无需单独安装） |

<!-- readme-section:help -->
## 遇到问题？

- Docs: https://www.swarmvault.ai/docs
- Providers: https://www.swarmvault.ai/docs/providers
- Troubleshooting: https://www.swarmvault.ai/docs/getting-started/troubleshooting
- npm package: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub issues: https://github.com/swarmclawai/swarmvault/issues

<!-- readme-section:development -->
## 开发

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

PR 指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，已发布包验证流程见 [docs/live-testing.md](docs/live-testing.md)。

<!-- readme-section:links -->
## 链接

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault

<!-- readme-section:license -->
## 许可证

MIT
