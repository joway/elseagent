# ElseAgent

一个用于学习 Agent 架构的个人助手，通过 Telegram 接收消息，调用工具完成任务。底层由 [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core) 驱动 agent 循环，通过 [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) 对接多 provider LLM。

## 架构概览

```
Telegram Bot (index.ts)
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│ runAgent (agent.ts)                                             │
│   ├─ Planner (planner.ts)       先判断简单/复杂，必要时生成步骤    │
│   ├─ Skills (skills.ts)         按需加载 skill 指引注入 system    │
│   └─ Agent 实例 (pi-agent-core) 驱动 ReAct 循环                   │
│        ├─ pi-ai stream()        LLM 调用（Anthropic provider）   │
│        ├─ AgentTool.execute()   TypeBox 校验后执行工具            │
│        └─ subscribe 事件流      → logger + Braintrust 子 span    │
└─────────────────────────────────────────────────────────────────┘
    │
    ├── Tools (tools.ts)          AgentTool[]，TypeBox schema
    │     ├── run_shell           执行 shell 命令 / 代码
    │     ├── run_applescript     macOS 应用/系统控制
    │     ├── write_file          写文件
    │     ├── read_file           读文件
    │     ├── list_files          列目录
    │     ├── search_memory       向量语义搜索历史对话
    │     ├── get_recent_memory   返回最近 N 条对话
    │     ├── create_cron         创建定时任务
    │     ├── list_crons          列出所有定时任务
    │     ├── delete_cron         删除定时任务
    │     └── load_skill          按需加载 skill 完整指引
    │
    ├── Memory (memory.ts)        持久化记忆
    │     ├── 存储：JSONL 按月分文件，每条含 embedding 向量
    │     ├── 向量搜索：余弦相似度，本地模型 all-MiniLM-L6-v2
    │     └── 时序检索：直接按时间倒序返回最近 N 条
    │
    ├── Scheduler (scheduler.ts)  定时任务
    │     ├── 持久化：workspace/crons.json
    │     ├── 恢复：启动时自动加载并重新调度
    │     └── 执行：触发时完整跑一次 runAgent，结果发回 Telegram
    │
    ├── Skills (skills.ts)        模块化能力包
    │     ├── 扫描 skillsDir 下的 .md frontmatter → 生成摘要
    │     ├── 摘要始终注入 system prompt
    │     └── 完整指引按需通过 load_skill 工具加载
    │
    ├── Setup (setup.ts)          首次启动引导，交互式填 .env
    │
    ├── Updater (updater.ts)      启动时检查 npm 新版本，自动更新重启
    │
    └── Logger (logger.ts)        可观测性
          ├── 终端：带颜色 + emoji，区分不同步骤类型
          └── 文件：纯文本，按天滚动（LOG_DIR/YYYY-MM-DD.log）
```

## Agent 循环（pi-agent-core 驱动）

整个 ReAct 循环由 pi-agent-core 的 `Agent` 类内部维护，我们只负责提供 **系统提示词、模型、工具、历史消息** 这些初始状态，然后订阅事件流来打日志和上报指标。

```
用户消息
  │
  ▼
┌── Planner phase (planner.ts) ──────────────┐
│  用 haiku 快速判断任务复杂度                 │
│  ├── SIMPLE → 跳过                         │
│  └── 复杂 → 生成 Step 1..N，注入 system     │
└────────────────────────────────────────────┘
  │
  ▼
┌── new Agent({ initialState, convertToLlm, sessionId }) ──┐
│                                                          │
│   agent.prompt(userMessage) 触发内部循环：                │
│                                                          │
│   ┌─ turn_start                                          │
│   │                                                      │
│   ├─ convertToLlm(messages) → pi-ai stream()             │
│   │    逐块发出 text_delta / toolcall_delta / ...        │
│   │                                                      │
│   ├─ message_end { assistant with content blocks }       │
│   │    content: [text, thinking?, toolCall*] 混合块       │
│   │                                                      │
│   ├─ stopReason == 'toolUse'?                            │
│   │    ├─ AJV 校验每个 toolCall 的 arguments              │
│   │    ├─ 并发执行 AgentTool.execute()                    │
│   │    ├─ 结果作为 toolResult 消息追加                     │
│   │    └─ → 下一轮 turn_start                             │
│   │                                                      │
│   └─ stopReason == 'stop' → agent_end                    │
└──────────────────────────────────────────────────────────┘
  │
  ▼
从 agent.state.messages 里提取最后一条 assistant text → 回发 Telegram
```

**关键设计点：**

- **无手写 ReAct 循环**：loop 管控、并行工具执行、参数校验、中断信号传播全由 pi-agent-core 负责
- **messages 是工作记忆**：一次 `runAgent` 里的完整推理过程都在 `agent.state.messages` 里
- **跨消息状态**：通过 index.ts 的 session map（时间窗口）+ Memory 模块双轨维护
- **最大迭代保护**：订阅 `turn_start` 计数，超过 20 轮调 `agent.abort()`

## 事件流与日志映射

`agent.subscribe()` 拿到的 `AgentEvent` 会翻译成 logger 的 StepType：

| AgentEvent | StepType | 图标 | 动作 |
|-----------|---------|------|------|
| `turn_start` | `system` | ⚙️ | 打 `--- Turn N ---`，超限触发 abort |
| `message_end` (assistant) | `api_res` + `think` | 📥/🤔 | 打模型名/tokens/stopReason，遍历 text block |
| `tool_execution_start` | `tool_call` | 🔧 | 记工具名 + 参数 |
| `tool_execution_end` | `tool_result` / `error` | 📋/❌ | 记返回 content |
| `agent_end` | — | — | 循环结束（在 `await agent.prompt()` 外统一收尾）|

其他 StepType：`user` 👤 / `response` 💬 / `info` ℹ️ / `api_req` 📤（目前未使用）。

## Braintrust 追踪

`@anthropic-ai/sdk` 被 pi-ai 取代后无法再用 `wrapAnthropic` 自动包装，改为**手动打子 span**：

```
agent span (type: task)
  ├─ planner span (type: llm)       — 在 planner.ts 里 traced
  ├─ llm.<model> span (type: llm)   — 每个 turn 的 assistant message_end 触发
  ├─ llm.<model> span (type: llm)
  └─ ...
```

每个 LLM 子 span 写入标准指标键，Braintrust 服务端据此计算 **Estimated cost**：

| pi-ai `usage.*` | Braintrust metric |
|---|---|
| `input` | `prompt_tokens` |
| `output` | `completion_tokens` |
| `totalTokens` | `tokens` |
| `cacheRead` | `prompt_cached_tokens` |
| `cacheWrite` | `prompt_cache_creation_tokens` |
| `cost.total` | `cost_usd`（自定义兜底）|

外层 agent span 额外挂一份累加后的 totals，方便在列表视图直接看单次对话总成本。

## Prompt Caching

由 pi-ai 的 Anthropic provider 自动处理。传入 `sessionId: 'chat-<chatId>'` 后，同一会话连续请求会自动命中 KV cache。相较原先手写 `cache_control: { type: 'ephemeral' }` 失去了显式 breakpoint 控制，但胜在省事。

## 会话上下文（时间窗口）

index.ts 维护 `sessions: Map<chatId, { history, lastActivity }>`：

- 两条消息间隔 > `SESSION_TIMEOUT_MIN` 分钟 → 视为新会话，清空上下文
- 每个会话最多保留 `SESSION_MAX_TURNS` 轮（1 轮 = 1 问 1 答）
- 超过窗口的内容走 Memory 检索兜底

## 记忆系统

**存储格式**（`memory/YYYY-MM.jsonl`，每行一条）：
```json
{"ts":"2026-04-04T08:00:00Z","chatId":123,"user":"...","agent":"...","embedding":[...]}
```

**两种检索方式**：
- `search_memory`：将 query embed 后做余弦相似度排序，语义搜索
- `get_recent_memory`：直接按时间倒序，适合"刚才做了什么"

**Embedding 模型**：`Xenova/all-MiniLM-L6-v2`，384 维，首次运行自动下载（~30MB），之后完全离线。

## Skills 系统

**目录结构**：每个 skill 是 `skillsDir/<name>/SKILL.md`，带 frontmatter：

```markdown
---
name: weather
description: 查询天气信息和预报
---

（完整指引，仅在 agent 调 load_skill 时注入）
```

**加载策略**：
- 启动时扫描一次，把 `name + description` 摘要拼进 system prompt
- Agent 判断某个 skill 相关时，主动调 `load_skill` 工具取完整内容
- 好处：system prompt 不膨胀，冷启动依然轻量

## 定时任务

- 配置持久化在 `workspace/crons.json`，进程重启自动恢复
- 使用标准 5 字段 cron 表达式（`node-cron` 解析）
- 任务触发时以 `task` 描述为输入完整执行一次 `runAgent`
- **注意**：依赖进程存活，进程退出则任务不触发

## 目录结构

```
elseagent/
├── src/
│   ├── index.ts       Telegram Bot 入口，初始化各模块
│   ├── agent.ts       runAgent 封装 pi-agent-core 的 Agent 实例
│   ├── planner.ts     任务规划阶段（pi-ai complete）
│   ├── tools.ts       AgentTool[] + TypeBox schema
│   ├── skills.ts      Skill 扫描与按需加载
│   ├── memory.ts      对话持久化、向量搜索
│   ├── scheduler.ts   定时任务管理
│   ├── setup.ts       首次启动引导
│   ├── updater.ts     自动更新检查
│   └── logger.ts      结构化日志（终端 + 文件）
├── skills/            内置 skills（随包发布，启动时同步到 skillsDir）
├── workspace/         运行时目录（自动创建）
│   ├── logs/          按天日志文件
│   ├── memory/        按月 JSONL 记忆文件
│   ├── skills/        用户自定义 skills
│   └── crons.json     定时任务配置
├── .env               环境变量
└── package.json
```

## 核心依赖

| 包 | 用途 |
|----|-----|
| `@mariozechner/pi-agent-core` | Agent 运行时：loop 管控、事件流、工具执行 |
| `@mariozechner/pi-ai` | 多 provider LLM 客户端：`getModel`, `complete`, `stream` |
| `@sinclair/typebox` | Tool 参数 schema（运行时校验 + 编译期类型）|
| `braintrust` | 可观测性，手动打 LLM 子 span |
| `@xenova/transformers` | 本地 embedding 模型（记忆检索）|
| `node-telegram-bot-api` | Telegram Bot |
| `node-cron` | 定时任务 |

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `TELEGRAM_TOKEN` | ✅ | — | Telegram Bot Token |
| `ANTHROPIC_API_KEY` | ✅ | — | Claude API Key |
| `ALLOWED_CHAT_ID` | — | 不限制 | 只响应该 chat_id |
| `WORKSPACE_DIR` | — | `./workspace` | 工作目录根路径 |
| `LOG_DIR` | — | `WORKSPACE_DIR/logs` | 日志目录 |
| `MEMORY_DIR` | — | `WORKSPACE_DIR/memory` | 记忆目录 |
| `SKILLS_DIR` | — | `WORKSPACE_DIR/skills` | Skills 目录 |
| `AGENT_MODEL` | — | `claude-opus-4-6` | 主 agent 模型 id（`npm run dev` 默认切到 `claude-haiku-4-5` 省钱）|
| `SESSION_TIMEOUT_MIN` | — | `5` | 会话超时（分钟）|
| `SESSION_MAX_TURNS` | — | `3` | 会话最多保留轮数 |
| `BRAINTRUST_API_KEY` | — | — | 配置后启用 Braintrust 追踪 |

## 启动

```bash
cp .env.example .env   # 填入 token 和 api key
npm run dev            # 用 haiku 省钱
# 或
npm start              # 用默认（Opus）
```

获取自己的 `ALLOWED_CHAT_ID`：先不填该变量启动，给 bot 发一条消息，日志里会打印 `chat_id=xxxxx`。
