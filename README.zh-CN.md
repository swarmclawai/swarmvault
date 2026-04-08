# SwarmVault

<!-- readme-language-nav:start -->
**语言:** [English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)
<!-- readme-language-nav:end -->

[![npm](https://img.shields.io/npm/v/@swarmvaultai/cli)](https://www.npmjs.com/package/@swarmvaultai/cli)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)]()

**面向 AI 代理的本地优先知识编译器。** 把原始文件、URL 和代码编译成持久化知识库。你不再把工作丢在聊天记录里，而是得到可以长期保存在磁盘上的 Markdown wiki、知识图谱、本地搜索和可审查的工件。

网站文档目前仍以英文为主。如果不同语言版本之间的表述出现偏差，请以 [README.md](README.md) 为准。

> 大多数“和文档聊天”的工具只回答一次问题，然后把过程全部丢掉。SwarmVault 把知识库本身当作产品。每一步都会写出可保留、可检查、可 diff、可持续改进的持久化工件。

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

<!-- readme-section:provider-setup -->
## 配置真实模型提供方

内置的 `heuristic` 提供方适合 smoke 测试和离线默认场景，但不适合正式的高质量知识编译与问答。真正使用时，请把知识库指向一个实际模型提供方：

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

其他后端和配置方式请参阅 [provider docs](https://www.swarmvault.ai/docs/providers)。

## 直接指向仓库或文档中心

最容易感受到 SwarmVault 价值的方式，是使用 managed-source 工作流：

```bash
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://example.com/docs/getting-started
swarmvault source list
swarmvault source reload --all
```

`source add` 会注册来源、把内容同步进知识库、执行一次 compile，并在 `wiki/outputs/source-briefs/` 下写出该来源的简报。`ingest` 仍适合单次文件或 URL，`add` 仍适合研究资料/文章的标准化采集。

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
| Code | `.js .jsx .ts .tsx .py .go .rs .java .kt .kts .scala .sc .lua .zig .cs .c .cpp .php .rb .ps1` | 基于 tree-sitter 的 AST 与模块解析 |
| PDF | `.pdf` | 本地文本提取 |
| DOCX | `.docx` | 本地提取与元数据捕获 |
| HTML | `.html`、URL | Readability + Turndown 转 Markdown |
| Images | `.png .jpg .webp` | Vision provider（已配置时） |
| Research | arXiv、DOI、文章、X/Twitter | 通过 `swarmvault add` 标准化为 Markdown |
| Text docs | `.md .mdx .txt .rst .rest` | 直接 ingest，并对 `.rst` 做轻量标题归一化 |
| Browser clips | inbox bundles | 通过 `inbox import` 重写资产路径后的 Markdown |
| Managed sources | 本地目录、公开 GitHub 仓库根 URL、文档中心 URL | 通过 `swarmvault source add` 的 registry 同步 |

<!-- readme-section:what-you-get -->
## 你能得到什么

**带来源依据的知识图谱** - 每条边都能追溯到具体来源与具体陈述。节点包含 freshness、confidence 和 community membership。

**God nodes 与社区分析** - 自动识别连接度最高的桥接节点。图谱报告页会用自然语言解释“为什么这个连接值得关注”。

**由 schema 驱动的编译** - 每个知识库都带有 `swarmvault.schema.md`，编译器会遵循其中定义的命名规则、分类方式与 grounding 要求。

**save-first 查询** - 默认把答案写入 `wiki/outputs/`，让有价值的工作不断积累而不是消失。支持 `markdown`、`report`、`slides`、`chart` 和 `image` 输出格式。

**可审查的变更流** - `compile --approve` 会把变更先写入 approval bundles。新概念和实体会先进入 `wiki/candidates/`，不会静默修改。

**12+ LLM providers** - OpenAI、Anthropic、Gemini、Ollama、OpenRouter、Groq、Together、xAI、Cerebras、通用 OpenAI-compatible、自定义适配器，以及离线默认的 heuristic。

**9 种 agent 集成** - 支持 Codex、Claude Code、Cursor、Goose、Pi、Gemini CLI、OpenCode、Aider 和 GitHub Copilot CLI。可选 graph-first hooks 会先引导代理读取 wiki，再进行大范围搜索。

**MCP server** - `swarmvault mcp` 通过 stdio 把知识库暴露给任意兼容的代理客户端。

**自动化** - watch 模式、git hooks、定时任务和 inbox import 让知识库持续保持最新状态。

**托管来源** - `swarmvault source add|list|reload|delete` 可以把重复使用的目录、公开 GitHub 仓库和文档站点变成有名字的同步来源，注册表保存在 `state/sources.json`，来源简报写入 `wiki/outputs/source-briefs/`。

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

SwarmVault 按能力而不是按品牌路由。内置 provider 类型：

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
