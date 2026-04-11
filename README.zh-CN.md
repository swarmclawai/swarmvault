# SwarmVault

<!-- readme-language-nav:start -->
**语言:** [English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)
<!-- readme-language-nav:end -->

[![npm](https://img.shields.io/npm/v/@swarmvaultai/cli)](https://www.npmjs.com/package/@swarmvaultai/cli)
[![npm downloads](https://img.shields.io/npm/dw/@swarmvaultai/cli)](https://www.npmjs.com/package/@swarmvaultai/cli)
[![GitHub stars](https://img.shields.io/github/stars/swarmclawai/swarmvault)](https://github.com/swarmclawai/swarmvault)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)]()

**面向 AI 代理的本地优先知识编译器**，基于 [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 模式构建。大多数”和文档聊天”的工具只回答一次问题，然后把过程全部丢掉。SwarmVault 在你和原始资料之间维护一个**持久化 wiki** —— LLM 负责记录整理，你负责思考。

网站文档目前仍以英文为主。如果不同语言版本之间的表述出现偏差，请以 [README.md](README.md) 为准。

<!-- readme-section:try-it -->
## 30 秒体验

```bash
npm install -g @swarmvaultai/cli
swarmvault scan ./your-repo       # 指向你自己的代码库或文档
# → 知识图谱在浏览器中打开
```

没有现成的仓库？试试内置 demo —— 创建一个包含三个来源的示例 vault 并打开图谱查看器：

```bash
swarmvault demo
```

![SwarmVault graph workspace](https://www.swarmvault.ai/images/screenshots/graph-workspace.png)

这条命令会初始化一个 vault、导入来源、编译知识图谱并打开交互式查看器。无需 API key —— 内置的 heuristic provider 完全离线运行。

**磁盘上的产物：**

- **知识图谱** —— 带类型化节点（sources、concepts、entities、code modules）和来源追溯边
- **可搜索的 wiki 页面** —— 源摘要、概念页、实体页、交叉引用
- **矛盾检测** —— 跨来源的冲突声明自动标记
- **图谱报告** —— 惊喜评分、god nodes、社区检测、自然语言解释

### 三层架构

SwarmVault 采用三层架构，遵循 Andrej Karpathy 描述的模式：

1. **原始来源** (`raw/`) —— 你精心收集的源文档。书籍、文章、论文、转录稿、代码、图片、数据集。它们是不可变的：SwarmVault 只读取，从不修改。
2. **Wiki** (`wiki/`) —— LLM 生成和人工编写的 Markdown 文件。源摘要、实体页、概念页、交叉引用、仪表盘和输出。Wiki 是持续积累的持久化工件。
3. **Schema** (`swarmvault.schema.md`) —— 定义 wiki 的组织方式、遵循的约定，以及你的领域中哪些内容最重要。你和 LLM 会共同演进这个文件。

> 继承 Vannevar Bush 的 Memex（1945）理念 —— 一个带有文档间关联路径的个人化知识库 —— SwarmVault 把来源之间的联系视为与来源本身同等重要。Bush 无法解决的是谁来做维护工作。LLM 解决了这个问题。

把书籍、文章、笔记、转录稿、邮件导出、日历、数据集、幻灯片、截图、URL 和代码编译成持久化知识库，包含知识图谱、本地搜索、仪表盘和可审查的工件。可用于**个人知识管理**、**研究深潜**、**读书伴侣**、**代码文档**、**商业智能**，或任何需要长期积累知识并加以组织的领域。

SwarmVault 把 LLM Wiki 模式做成了带有图谱导航、搜索、审查、自动化和可选模型增强的本地工具链。你也可以从[独立 schema 模板](templates/llm-wiki-schema.md)开始 —— 零安装，任何 LLM 代理 —— 当你需要更多功能时再升级到完整 CLI。

<!-- readme-section:why -->
## 为什么选择 SwarmVault

如果你喜欢 Karpathy 的 [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)，SwarmVault 就是它的生产级版本。以下是它如何解决社区最关注的问题：

**"幻觉不会越积越多吗？"** —— 每条边都标记为 `extracted`、`inferred` 或 `ambiguous`。矛盾检测会标记冲突声明。`compile --approve` 把所有变更放入可审查的 approval bundle。新概念先进入 `wiki/candidates/`。`lint --conflicts` 可按需审计矛盾。

**"能扩展到 100 页以上吗？"** —— 可以。混合搜索把 SQLite 全文索引与语义 embeddings 合并，不需要把每个页面都塞进上下文。`compile --max-tokens` 裁剪输出以适配有限窗口。图谱导航（`graph query`、`graph path`、`graph explain`）让你可以遍历而非搜索。

**"只能个人使用吗？"** —— Git 工作流（`--commit`）、watch 模式加 git hooks、定时自动化和 MCP server 让它适合团队使用。Agent 集成覆盖 12 个工具。

**"需要 API key 吗？"** —— 不需要。内置 `heuristic` provider 完全离线。如果想要更高质量的提取，可以搭配免费的本地 LLM，例如 [Ollama](https://ollama.com)。云端 provider 是可选的。

<!-- readme-section:comparison -->
## 从 Gist 到生产

| | Karpathy Gist | **SwarmVault** |
|---|:---:|:---:|
| 三层架构 | 描述 | **已实现** |
| Ingest / query / lint | 手动 | **CLI 命令** |
| 一条命令启动 | — | **`swarmvault scan`** |
| 类型化知识图谱 | — | **是** |
| 交互式图谱查看器 | — | **是** |
| 30+ 输入格式 | — | **是** |
| 代码感知（tree-sitter AST） | — | **是** |
| 离线 / 无需 API key | — | **是** |
| 矛盾检测 | 提及 | **自动** |
| Approval 审批队列 | — | **是** |
| 12 种 agent 集成 | — | **是** |
| Neo4j / 图谱导出 | — | **是** |
| MCP server | — | **是** |
| Watch 模式 + git hooks | — | **是** |
| 混合搜索 + rerank | index.md | **SQLite FTS + embeddings** |

<!-- readme-section:install -->
## 安装

### 桌面应用（无需 Node.js）

下载适用于 macOS、Windows 或 Linux 的桌面应用——自带运行时：

**[下载桌面应用](https://www.swarmvault.ai/download)** | [GitHub Releases](https://github.com/swarmclawai/swarmvault-desktop/releases)

### CLI

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

```bash
# 完整工作流 —— 分步执行
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
swarmvault graph blast ./src/index.ts
swarmvault query "What is the auth flow?"
swarmvault graph serve
swarmvault graph export --report ./exports/report.html
swarmvault graph export --obsidian ./exports/graph-vault
swarmvault graph push neo4j --dry-run
```

想要对本地仓库或文档树做最快的一次性扫描？`swarmvault scan ./path --no-serve` 会将当前目录初始化为 vault，导入该目录并完成编译；加上 `--no-serve` 时不会启动图谱查看器。

如果你想在还没准备真实素材前就先做一次零配置体验，也可以运行 `swarmvault demo --no-serve`。它会创建一个临时示例 vault，写入内置来源并立即完成编译。

对于非常大的图，`swarmvault graph serve` 和 `swarmvault graph export --html` 会自动进入 overview mode。若你仍想强制渲染完整画布，请添加 `--full`。

如果这个 vault 本身就在 git 仓库里，`ingest`、`compile` 和 `query` 还支持 `--commit`，可以把生成出来的 `wiki/` 与 `state/` 变更立即提交。`compile --max-tokens <n>` 则会在需要控制上下文窗口时裁剪较低优先级页面。

`swarmvault init --profile` 支持 `default`、`personal-research`，也支持 `reader,timeline` 这种逗号分隔的 preset 组合。`personal-research` preset 会同时开启 `profile.guidedIngestDefault` 和 `profile.deepLintDefault`，所以 ingest/source 与 lint 默认都会走更强的路径，除非你显式传入 `--no-guide` 或 `--no-deep`。若要自定义知识库行为，请直接编辑 `swarmvault.config.json` 里的 `profile` 配置块，并把 `swarmvault.schema.md` 继续当作人工维护的意图层。

<!-- readme-section:provider-setup -->
## 可选：添加模型提供方

开始使用 SwarmVault 并不需要 API key，也不需要外部模型提供方。内置的 `heuristic` 提供方可以支持本地/离线的知识库初始化、ingest、compile、graph/report/search，以及轻量级的 query 和 lint 默认流程。

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

### 本地语义 Embeddings

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

当有可用的 embedding 能力提供方时，SwarmVault 还会默认把语义页面匹配并入本地搜索结果。`tasks.embeddingProvider` 是显式指定该后端的方式，但如果当前 `queryProvider` 也支持 embeddings，SwarmVault 也可以回退使用它。若再设置 `search.rerank: true`，则会让当前 `queryProvider` 对合并后的顶部候选结果重新排序。

### 云端 API 提供方

如需使用云端模型，请在配置中添加 provider 并填入 API key：

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

如果要导入音频文件，请把 `tasks.audioProvider` 指向具备 `audio` 能力的 provider。YouTube 转录导入则不需要模型 provider。

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

`source add` 会注册来源、把内容同步进知识库、执行一次 compile，并在 `wiki/outputs/source-briefs/` 下写出该来源的简报。加入 `--guide` 后，会额外创建一个可恢复的引导式 session，写入 `wiki/outputs/source-sessions/`，并在 `profile.guidedSessionMode` 为 `canonical_review` 时通过 approval queue 阶段化对 canonical 页面（source/concept/entity）的更新；如果配置为 `insights_only`，则会把引导式整合内容保留在 `wiki/insights/` 中。你也可以在 `swarmvault.config.json` 中设置 `profile.guidedIngestDefault: true`，让 `ingest`、`source add` 和 `source reload` 默认进入引导式模式；当某次运行只想走轻量路径时，用 `--no-guide` 覆盖。它现在同样适用于可重复同步的本地文件，而不仅是目录、公开仓库或文档站点。`ingest` 仍适合单次文件或 URL，`add` 仍适合研究资料/文章的标准化采集。

<!-- readme-section:agent-setup -->
## Agent 与 MCP 设置

先把知识库规则安装到你的编码代理中：

```bash
swarmvault install --agent claude --hook    # Claude Code + graph-first hook
swarmvault install --agent codex            # Codex
swarmvault install --agent cursor           # Cursor
swarmvault install --agent copilot --hook   # GitHub Copilot CLI + hook
swarmvault install --agent gemini --hook    # Gemini CLI + hook
swarmvault install --agent trae             # Trae
swarmvault install --agent claw             # Claw / OpenClaw skill target
swarmvault install --agent droid            # Droid / Factory rules target
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
| 音频 | `.mp3 .wav .m4a .aac .ogg .webm` 及其他 `audio/*` 文件 | 在已配置 `tasks.audioProvider` 时进行 provider 驱动的转录 |
| HTML | `.html`、URL | Readability + Turndown 转 Markdown（URL 抓取） |
| YouTube URL | `youtube.com/watch`、`youtu.be`、`youtube.com/embed`、`youtube.com/shorts` | 直接抓取转录文本，并提取标题与视频元数据 |
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

**可配置 profile** - 通过 `swarmvault.config.json` 中的 `profile.presets`、`profile.dashboardPack`、`profile.guidedSessionMode`、`profile.guidedIngestDefault`、`profile.deepLintDefault` 和 `profile.dataviewBlocks` 组合出自己的知识库模式，而不是等待新的硬编码产品模式。`personal-research` 只是一个内置 preset 别名。

**引导式 session** - `ingest --guide`、`source add --guide`、`source reload --guide`、`source guide <id>` 和 `source session <id>` 会创建可恢复的 source session，写入 `wiki/outputs/source-sessions/`，并在你接受之前阶段化 source review、source guide，以及基于 profile 配置流向 canonical 页面或 `wiki/insights/` 的更新提案。在 `swarmvault.config.json` 中设置 `profile.guidedIngestDefault: true` 可以让 ingest 和 source 命令默认使用引导式模式；用 `--no-guide` 覆盖。

**deep lint 默认值** - 在 `swarmvault.config.json` 中设置 `profile.deepLintDefault: true`，可以让 `swarmvault lint` 默认包含 LLM 驱动的 advisory deep lint；如果某一次只想运行结构性检查，用 `--no-deep` 覆盖即可。

**Web-search 增强 lint** — `lint --deep --web` 使用已配置的 web-search provider（`http-json` 或 `custom`）在 deep-lint 中引入外部证据片段。Web search 目前仅限于 deep lint；其他命令仅查询本地 vault 状态。

**知识仪表盘** - `wiki/dashboards/` 会生成 recent sources、reading log、timeline、source sessions、source guides、research map、contradictions 和 open questions 页面。默认先保证普通 Markdown 可读；当 `profile.dataviewBlocks` 打开时，会额外附加适合 Obsidian Dataview 的查询块。

**混合搜索与 rerank** - 当有可用的 embedding 能力提供方时，本地搜索会把 SQLite 全文命中与语义页面匹配合并起来。`tasks.embeddingProvider` 是显式指定该后端的方式，但如果当前 `queryProvider` 也支持 embeddings，SwarmVault 也可以回退使用它。若设置 `search.rerank: true`，还会让当前 `queryProvider` 在 `query` 回答前对候选结果做一次重排。

**带 token 预算的 compile 与自动提交** - `compile --max-tokens <n>` 会裁剪低优先级页面，让生成的 wiki 输出控制在给定 token 预算内；`ingest|compile|query --commit` 则可以在 vault 位于 git 仓库中时立即提交 `wiki/` 与 `state/` 的变更。

**图谱健康信号** - graph report 产物现在还会给出 community cohesion 摘要、孤立节点与高歧义边的告警，以及针对薄弱或模糊图区域的更明确 follow-up questions。

**图谱 blast radius 与报告导出** - `graph blast <target>` 会沿模块依赖的反向 import 链追踪改动影响范围，`graph export --report` 则会生成一个自包含的 HTML 图谱报告，展示统计、关键节点、社区和告警。

**图谱 diff** - `swarmvault diff` 将当前知识图谱与上次提交的版本进行对比，显示新增/移除的节点、边和页面，让你清楚看到每次 compile 改变了什么。

**Obsidian 图谱导出** - `graph export --obsidian` 会写出一个适合 Obsidian 打开的笔记包，保留原有 wiki 目录结构，附加图谱连接、社区页面、孤立节点 stub、复制后的资产文件，以及最小化的 `.obsidian` 配置。

**自适应图谱社区划分** - SwarmVault 会根据小图或稀疏图自动调整 Louvain community resolution；如果你想固定聚类结果，可以在 `swarmvault.config.json` 中设置 `graph.communityResolution`。

**可选模型提供方** - OpenAI、Anthropic、Gemini、Ollama、OpenRouter、Groq、Together、xAI、Cerebras、通用 OpenAI-compatible、自定义适配器，以及适合离线/本地默认流程的 heuristic。

**12 种 agent 集成** - 支持 Codex、Claude Code、Cursor、Goose、Pi、Gemini CLI、OpenCode、Aider、GitHub Copilot CLI、Trae、Claw/OpenClaw 和 Droid。可选 graph-first hooks 会先引导支持的 agent 读取 wiki，再进行大范围搜索。

**MCP server** - `swarmvault mcp` 通过 stdio 把知识库暴露给任意兼容的代理客户端。

**内置浏览器剪藏器** - `graph serve` 会暴露本地 `/api/bookmarklet` 页面和 `/api/clip` 接口，让正在运行的 vault 可以一键收录当前浏览器 URL。

**自动化** - watch 模式、git hooks、定时任务和 inbox import 让知识库持续保持最新状态。

**托管来源** - `swarmvault source add|list|reload|review|guide|session|delete` 可以把重复使用的本地文件、目录、公开 GitHub 仓库和文档站点变成有名字的同步来源，注册表保存在 `state/sources.json`，来源简报写入 `wiki/outputs/source-briefs/`，可恢复的 session 锚点写入 `wiki/outputs/source-sessions/`，引导式整合产物写入 `wiki/outputs/source-guides/`。

**Source artifact 类型：**

| Artifact | 创建方式 | 用途 |
|----------|---------|------|
| Source brief | `source add`、`ingest`（始终创建） | 自动生成的摘要，写入 `wiki/outputs/source-briefs/` |
| Source review | `source review`、`source add --guide` | 较轻量的评估，写入 `wiki/outputs/source-reviews/` |
| Source guide | `source guide`、`source add --guide` | 引导式整合，生成 approval-bundled 更新，写入 `wiki/outputs/source-guides/` |
| Source session | `source session`、`source add --guide` | 可恢复的工作流状态，保存在 `wiki/outputs/source-sessions/` 和 `state/source-sessions/` |

**外部图谱输出** - 可导出为完整 HTML、轻量 standalone HTML、自包含 report HTML、SVG、GraphML、Cypher、JSON、Obsidian 笔记包或 Obsidian canvas，也可以通过 Bolt/Aura 直接把实时图谱推送到 Neo4j，并用共享数据库安全的 `vaultId` 进行命名空间隔离。

**大型仓库加固** - 面对大批量仓库 ingest 和 compile 时会输出有边界的进度提示；parser 兼容性失败只会影响对应源文件并留下明确诊断；仅代码改动的 repo watch cycle 会跳过非代码重分析；图谱报告会把过于碎片化的小社区折叠展示，保持可读性。

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
| Trae | `swarmvault install --agent trae` |
| Claw / OpenClaw | `swarmvault install --agent claw` |
| Droid | `swarmvault install --agent droid` |

Claude Code、OpenCode、Gemini CLI 和 Copilot 还支持 `--hook`，用于 graph-first 上下文注入。

<!-- readme-section:worked-examples -->
## 示例项目

每个目录都包含真实输入文件和实际输出结果，你可以直接运行验证。

| 示例 | 展示内容 | 来源 |
|------|----------|------|
| **[research-deep-dive](worked/research-deep-dive/)** | 论文和文章构建带跨来源矛盾检测的演化论点 | `worked/research-deep-dive/` |
| **[personal-knowledge-base](worked/personal-knowledge-base/)** | 日记、健康笔记、播客编译成带仪表盘的个人 Memex | `worked/personal-knowledge-base/` |
| **[book-reading](worked/book-reading/)** | 逐章阅读构建角色和主题页，随阅读积累 | `worked/book-reading/` |
| **[code-repo](worked/code-repo/)** | 仓库 ingest、模块页、图谱报告、benchmark | `worked/code-repo/` |
| **[capture](worked/capture/)** | 面向研究资料的 `add` 捕获，支持 arXiv、DOI、URL 标准化元数据 | `worked/capture/` |
| **[mixed-corpus](worked/mixed-corpus/)** | compile、review、save-first 输出循环，跨混合输入类型 | `worked/mixed-corpus/` |

分步演示见 [examples guide](https://www.swarmvault.ai/docs/getting-started/examples)。

<!-- readme-section:providers -->
## Providers

模型提供方是可选的。SwarmVault 按能力而不是按品牌路由。内置 provider 类型：

`heuristic` `openai` `anthropic` `gemini` `ollama` `openrouter` `groq` `together` `xai` `cerebras` `openai-compatible` `custom`

配置示例见 [provider docs](https://www.swarmvault.ai/docs/providers)。

<!-- readme-section:privacy -->
## 隐私与数据流

SwarmVault 默认在本地处理数据：

- **代码文件** 通过 tree-sitter 在本地解析。源代码内容不会发送到外部 API。
- **文档和文本** 发送到已配置的 provider 进行语义提取。使用内置 `heuristic` provider 时，所有数据保留在本地。
- **图像** 仅在配置了视觉 provider 时才发送。
- **Heuristic 模式**（默认）完全离线运行——无需 API 密钥，无需网络连接。

添加模型 provider（OpenAI、Anthropic、Ollama 等）后，仅非代码内容会发送到 LLM 进行分析。所有图谱构建、社区检测和报告生成均在本地完成。

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
