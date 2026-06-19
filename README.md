# ElseAgent

> A personal assistant agent over Telegram, powered by Claude.

ElseAgent 是一个跑在你自己机器上的个人助理。你通过 Telegram 给它发消息，它会**像 agent 一样自主推理、调用工具、写代码、执行命令**来完成任务——还能控制你的 Mac、记住过往对话、按 cron 定时执行任务。

```
你 ──Telegram──▶  ElseAgent  ──┬─▶  写/跑代码、执行 shell
                                ├─▶  控制 macOS（AppleScript）
                                ├─▶  语义记忆（向量检索）
                                └─▶  定时任务（cron）
```

## 特性

- **ReAct Agent 循环**：think → 调工具 → 观察结果 → 继续，直到完成任务。
- **会写代码会执行**：`write_file` + `run_shell`，能装包、跑脚本、解决实际问题。
- **控制 Mac**：通过 AppleScript 操作 Music.app / Spotify / 音量 / Finder 等。
- **长期记忆**：每轮对话自动存盘，支持向量语义检索（本地 embedding，无需 API）。
- **定时任务**：让 agent 自己用 cron 安排重复任务，触发时把结果推回 Telegram。
- **Skills**：可插拔的 Markdown 技能文件，摘要常驻、正文按需加载，节省 context。
- **任务规划**：进入主循环前先用快模型判断任务复杂度，复杂任务自动拆解成步骤。
- **实时进度**：执行过程中把每一步显示到 Telegram，任务完成后撤回，只留最终答案。
- **多后端**：默认走 Anthropic API，也可切到 `claude -p` 或 `codex exec` 复用各自订阅额度。
- **开箱即用**：首次启动交互式引导填配置，启动时自动检查 npm 新版本并升级重启。
- **可观测**：可选接入 [Braintrust](https://braintrust.dev) 做 tracing 和成本统计。

## 架构

整个系统由一个长驻 Node 进程驱动，分为「入口 / Agent 核心 / 工具 / 支撑模块」四层。

```
                         ┌──────────────────────────────────────────┐
   Telegram 消息  ─────▶ │ index.ts                                  │
                         │  鉴权 · 会话窗口 · 并发控制 · 进度上报      │
                         └───────────────┬──────────────────────────┘
                                         │ runAgent(text, ctx, history)
                                         ▼
        ┌────────────────────────────────────────────────────────────┐
        │ agent.ts  —  ReAct 主循环（@mariozechner/pi-agent-core）     │
        │                                                              │
        │   planner.ts ──▶ 判断复杂度，复杂则拆步骤注入 system prompt   │
        │   skills.ts  ──▶ 把可用 skill 摘要注入 system prompt          │
        │                                                              │
        │   while (未完成):                                            │
        │     1. 调 LLM（pi-ai → Anthropic）                           │
        │     2. 若请求 tool_use → 执行 tools.ts 里的工具 → 回灌结果    │
        │     3. 否则结束，返回最终文本                                 │
        └───────────────┬──────────────────────────────────────────────┘
                        │ buildTools(ctx)
                        ▼
        ┌────────────────────────────────────────────────────────────┐
        │ tools.ts  —  Agent 可调用的工具                             │
        │   run_shell · run_applescript · write/read/list_file        │
        │   search_memory · get_recent_memory  ──▶ memory.ts          │
        │   create/list/delete_cron            ──▶ scheduler.ts        │
        │   load_skill                         ──▶ skills.ts          │
        └────────────────────────────────────────────────────────────┘
```

### 模块职责

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | **入口**。Telegram bot 轮询、鉴权（`ALLOWED_CHAT_ID`）、单 chat 串行的并发控制、会话时间窗口、把执行过程实时编辑成「进度消息」、对话结束存 memory、初始化 scheduler。 |
| `src/agent.ts` | **Agent 核心**。基于 `pi-agent-core` 的 `Agent` 类驱动 ReAct 循环，订阅事件打日志/上报进度/记 Braintrust span。默认模型 `claude-opus-4-6`，可用 `AGENT_MODEL` 覆盖，最多 20 轮。 |
| `src/planner.ts` | **规划**。进主循环前用 `claude-haiku-4-5` 快速判断任务是 `SIMPLE` 还是需要多步，复杂任务把步骤列表注入 system prompt。 |
| `src/tools.ts` | **工具集**。用 TypeBox schema 定义每个工具（参数自动 AJV 校验），`buildTools(ctx)` 闭包捕获 `chatId` 等上下文。 |
| `src/memory.ts` | **记忆**。对话存为按月分片的 JSONL（含向量），`search_memory` 走余弦相似度语义检索，`get_recent_memory` 取最近 N 条。embedding 用本地 `Xenova/all-MiniLM-L6-v2`（384 维，离线运行）。 |
| `src/scheduler.ts` | **定时任务**。单例 `Scheduler`，cron 任务持久化到 `workspace/crons.json`，启动恢复，触发时跑 agent 并把结果发回对应 chat。 |
| `src/skills.ts` | **技能**。扫描 `skillsDir` 下带 frontmatter 的 `.md`，摘要常驻 system prompt，正文经 `load_skill` 按需加载。启动时把内置 skills（`skills/`）复制到用户目录（不覆盖）。 |
| `src/claudeCli.ts` / `src/codexCli.ts` | **替代后端**。把请求转发给 `claude -p` 或 `codex exec`，用各自订阅额度替代 API 计费（代价：只能用各 CLI 自带工具，本项目的 memory/cron/skills 工具不可用）。 |
| `src/setup.ts` | **首次引导**。`.env` 缺必填项时交互式问答（token/key 隐藏输入），写入 `.env`。 |
| `src/updater.ts` | **自动更新**。启动时查 npm registry，有新版则 `npm i -g` 并重启进程。 |
| `src/logger.ts` | 结构化日志，写到 `workspace/logs/`。 |

### 关键依赖

- **[`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core)** — 有状态的 agent 运行时，提供 `Agent` 类与 ReAct 循环、工具执行、事件订阅。
- **[`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai)** — 多 provider 的统一 LLM 客户端（这里走 Anthropic）。
- **`@sinclair/typebox`** — 工具参数的 JSON Schema（运行时校验 + 编译期类型）。
- **`@xenova/transformers`** — 本地 embedding，记忆的语义检索无需调用任何 API。
- **`node-telegram-bot-api`** — Telegram bot。
- **`node-cron`** — 定时任务调度。
- **`braintrust`**（可选）— LLM tracing 与成本统计。

## 快速开始

需要 Node.js ≥ 18。

```bash
# 通过 npm 全局安装后直接运行（首次会引导填配置）
npm install -g elseagent
elseagent

# 或从源码运行
git clone <repo> && cd elseagent
npm install
npm run dev      # 开发模式，用便宜的 haiku 模型并热重载
```

首次启动会引导你填入：

1. **Telegram Bot Token** — 找 Telegram 上的 [@BotFather](https://t.me/BotFather) 创建 bot 获取。
2. **Anthropic API Key** — 从 [console.anthropic.com](https://console.anthropic.com) 获取。
3. **Allowed Chat ID**（可选）— 留空则响应所有人；先启动 bot 发条消息，在日志里能看到自己的 `chat_id`，填上即可限定只响应你。

之后给你的 bot 发消息就能用了。

## 配置（环境变量）

写在 `.env` 里，参考 [`.env.example`](.env.example)。

| 变量 | 说明 |
| --- | --- |
| `TELEGRAM_TOKEN` | **必填**。Telegram bot token。 |
| `ANTHROPIC_API_KEY` | API 后端**必填**（CLI 后端不需要）。 |
| `ALLOWED_CHAT_ID` | 限定只响应某个 chat，留空则对所有人开放。 |
| `WORKSPACE_DIR` | 工作目录，默认 `./workspace`（文件、记忆、日志、cron 都在这）。 |
| `AGENT_MODEL` | 覆盖默认模型 `claude-opus-4-6`。 |
| `AGENT_BACKEND` | `claude` = 走 `claude -p`；`codex` = 走 `codex exec`；留空 = Anthropic API。 |
| `SESSION_TIMEOUT_MIN` | 两条消息间隔超过该分钟数视为新会话（默认 5）。 |
| `SESSION_MAX_TURNS` | 单会话保留的最大轮数（默认 3）。 |
| `BRAINTRUST_API_KEY` | 可选，启用 Braintrust tracing。 |
| `CLAUDE_CLI_PATH` / `CLAUDE_CLI_MODEL` | `claude` 后端可选项。 |
| `CODEX_CLI_PATH` / `CODEX_CLI_MODEL` / `CODEX_SANDBOX_MODE` | `codex` 后端可选项。 |

## 数据布局

所有运行时状态都落在 `WORKSPACE_DIR` 下：

```
workspace/
├── logs/            # 结构化日志，按时间分文件
├── memory/          # 对话记忆，按月分片的 JSONL（含 embedding 向量）
│   └── 2026-04.jsonl
├── skills/          # 技能 .md 文件（启动时从内置 skills/ 复制，用户可增改）
└── crons.json       # 持久化的定时任务
```

## 工作流程（一条消息的生命周期）

1. **收到消息** → 鉴权 → 若该 chat 正在处理则提示稍候（串行）。
2. **取会话上下文** → 超时则清空，否则带上最近几轮历史。
3. **规划** → `planner` 判断复杂度，复杂任务把分步计划注入 system prompt。
4. **Agent 循环** → 反复「调 LLM → 执行工具 → 观察」，过程实时显示到 Telegram。
5. **回复** → 发送最终答案（Telegram HTML 格式），撤回进度消息。
6. **存盘** → 异步把这轮对话写入 memory（含向量）。

定时任务触发时走相同的 agent 循环，结果直接推回对应 chat。

## License

MIT
