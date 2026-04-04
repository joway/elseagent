# ElseAgent

一个用于学习 Agent 架构的个人助手，通过 Telegram 接收消息，调用工具完成任务。

## 架构概览

```
Telegram Bot (index.ts)
    │
    ▼
Agent Loop (agent.ts)          ← ReAct 模式：Think → Act → Observe → 循环
    │
    ├── Tools (tools.ts)        ← 工具执行层
    │     ├── run_shell         执行 shell 命令 / 代码
    │     ├── write_file        写文件
    │     ├── read_file         读文件
    │     ├── list_files        列目录
    │     ├── search_memory     向量语义搜索历史对话
    │     ├── get_recent_memory 返回最近 N 条对话
    │     ├── create_cron       创建定时任务
    │     ├── list_crons        列出所有定时任务
    │     └── delete_cron       删除定时任务
    │
    ├── Memory (memory.ts)      ← 持久化记忆
    │     ├── 存储：JSONL 按月分文件，每条含 embedding 向量
    │     ├── 向量搜索：余弦相似度，本地模型 all-MiniLM-L6-v2
    │     └── 时序检索：直接按时间倒序返回最近 N 条
    │
    ├── Scheduler (scheduler.ts) ← 定时任务
    │     ├── 持久化：workspace/crons.json
    │     ├── 恢复：启动时自动加载并重新调度
    │     └── 执行：触发时完整跑一次 agent loop，结果发回 Telegram
    │
    └── Logger (logger.ts)       ← 可观测性
          ├── 终端：带颜色 + emoji，区分不同步骤类型
          └── 文件：纯文本，按天滚动（WORKSPACE_DIR/logs/YYYY-MM-DD.log）
```

## Agent Loop（ReAct 模式）

```
用户消息
  │
  ▼
[Think] 调用 Claude API（携带工具定义 + 消息历史）
  │
  ├── stop_reason == "end_turn"
  │     └── 返回最终回答 → 发送给用户
  │
  └── stop_reason == "tool_use"
        └── 执行工具 → 结果追加到 messages → 回到 Think
```

`messages` 数组是当次对话的工作记忆，记录完整推理过程。每次新消息开启一个新 loop，跨消息的记忆通过 Memory 模块检索。

## 日志类型

| 类型 | 图标 | 含义 |
|------|------|------|
| `user` | 👤 | 用户输入 |
| `think` | 🤔 | 模型输出的思考文字 |
| `system` | ⚙️ | agent 自身的状态信息（iteration、token 数等） |
| `tool_call` | 🔧 | 工具调用（含参数） |
| `tool_result` | 📋 | 工具返回结果 |
| `response` | 💬 | 最终回复 |
| `error` | ❌ | 错误 |
| `info` | ℹ️ | 启动信息等 |

## 记忆系统

**存储格式**（`memory/YYYY-MM.jsonl`，每行一条）：
```json
{"ts":"2026-04-04T08:00:00Z","chatId":123,"user":"...","agent":"...","embedding":[...]}
```

**两种检索方式**：
- `search_memory`：将 query embed 后做余弦相似度排序，语义搜索
- `get_recent_memory`：直接按时间倒序，适合"刚才做了什么"

**Embedding 模型**：`Xenova/all-MiniLM-L6-v2`，384 维，首次运行自动下载（~30MB），之后完全离线。

## 定时任务

- 配置持久化在 `workspace/crons.json`，进程重启自动恢复
- 使用标准 5 字段 cron 表达式（`node-cron` 解析）
- 任务触发时以 `task` 描述为输入完整执行一次 agent loop
- **注意**：依赖进程存活，进程退出则任务不触发

## 目录结构

```
elseagent/
├── src/
│   ├── index.ts       Telegram Bot 入口，初始化各模块
│   ├── agent.ts       ReAct 核心循环
│   ├── tools.ts       工具定义（JSON Schema）与执行逻辑
│   ├── memory.ts      对话持久化、向量搜索
│   ├── scheduler.ts   定时任务管理
│   └── logger.ts      结构化日志（终端 + 文件）
├── workspace/         运行时目录（自动创建）
│   ├── logs/          按天日志文件
│   ├── memory/        按月 JSONL 记忆文件
│   └── crons.json     定时任务配置
├── .env               环境变量
└── package.json
```

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `TELEGRAM_TOKEN` | ✅ | — | Telegram Bot Token |
| `ANTHROPIC_API_KEY` | ✅ | — | Claude API Key |
| `ALLOWED_CHAT_ID` | — | 不限制 | 只响应该 chat_id |
| `WORKSPACE_DIR` | — | `./workspace` | 工作目录根路径 |
| `LOG_DIR` | — | `WORKSPACE_DIR/logs` | 日志目录 |
| `MEMORY_DIR` | — | `WORKSPACE_DIR/memory` | 记忆目录 |

## 启动

```bash
cp .env.example .env   # 填入 token 和 api key
npm run dev
```

获取自己的 `ALLOWED_CHAT_ID`：先不填该变量启动，给 bot 发一条消息，日志里会打印 `chat_id=xxxxx`。
